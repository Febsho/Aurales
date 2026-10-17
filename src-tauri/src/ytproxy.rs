// Local loopback proxy that lets the webview's <video>/<audio> elements play
// googlevideo.com adaptive streams. googlevideo rejects open-ended Range
// requests (HTTP 403), which is exactly what Chromium's media stack sends, so
// this proxy translates them into the bounded chunk requests googlevideo
// accepts and replies with standard 206 responses the media element resumes
// from.

use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static AGENT: OnceLock<ureq::Agent> = OnceLock::new();

// googlevideo stream URLs are bound to the IP that requested them from the
// Innertube player API. On dual-stack machines the API call and the media
// fetches can otherwise egress over different IP families, which googlevideo
// rejects (302 -> 403) — so every YouTube request (player API + chunks) goes
// through one agent pinned to a single probed family.
pub fn agent() -> &'static ureq::Agent {
    AGENT.get_or_init(|| {
        let prefer_v6 = ("www.youtube.com", 443)
            .to_socket_addrs()
            .map(|addrs| {
                addrs.filter(SocketAddr::is_ipv6).any(|addr| {
                    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3))
                        .is_ok()
                })
            })
            .unwrap_or(false);
        log::info!(
            "[ytproxy] pinned to {}",
            if prefer_v6 { "IPv6" } else { "IPv4" }
        );
        ureq::AgentBuilder::new()
            .resolver(move |netloc: &str| -> std::io::Result<Vec<SocketAddr>> {
                let addrs: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
                let filtered: Vec<SocketAddr> = addrs
                    .iter()
                    .copied()
                    .filter(|a| a.is_ipv6() == prefer_v6)
                    .collect();
                Ok(if filtered.is_empty() { addrs } else { filtered })
            })
            // Each upstream operation is a bounded chunk/probe. Fail a stalled
            // origin quickly so its blocking worker cannot remain occupied.
            .timeout(Duration::from_secs(30))
            .timeout_connect(std::time::Duration::from_secs(8))
            .timeout_read(std::time::Duration::from_secs(30))
            .timeout_write(std::time::Duration::from_secs(8))
            // The loopback proxy accepts a URL from its caller. Never follow a
            // validated googlevideo URL to an arbitrary redirect target.
            .redirects(0)
            .build()
    })
}

// googlevideo 403s range requests larger than ~1MB on adaptive URLs, so serve
// the media element bounded 1MB slices; it re-requests the next slice itself.
const CHUNK_BYTES: u64 = 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_CLIENT_CONNECTIONS: usize = 16;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
static CLIENT_CONNECTIONS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn connection_slots() -> Arc<Semaphore> {
    Arc::clone(CLIENT_CONNECTIONS.get_or_init(|| Arc::new(Semaphore::new(MAX_CLIENT_CONNECTIONS))))
}

pub async fn ensure_started() -> Result<u16, String> {
    if let Some(port) = PROXY_PORT.get() {
        return Ok(*port);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("Failed to bind trailer proxy: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to read trailer proxy address: {e}"))?
        .port();
    if PROXY_PORT.set(port).is_err() {
        // Another caller won the race; use its listener.
        return Ok(*PROXY_PORT.get().expect("proxy port set"));
    }
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut stream, _)) => match connection_slots().try_acquire_owned() {
                    Ok(permit) => {
                        tokio::spawn(async move {
                            let _permit = permit;
                            let _ = handle_connection(stream).await;
                        });
                    }
                    Err(_) => {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(250),
                            write_simple(&mut stream, "503 Service Unavailable"),
                        )
                        .await;
                    }
                },
                Err(_) => break,
            }
        }
    });
    Ok(port)
}

async fn handle_connection(mut stream: TcpStream) -> std::io::Result<()> {
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let header_deadline = tokio::time::Instant::now() + HEADER_READ_TIMEOUT;
    while !buffer.windows(4).any(|w| w == b"\r\n\r\n") {
        if buffer.len() > MAX_REQUEST_BYTES {
            return write_simple(&mut stream, "431 Request Header Fields Too Large").await;
        }
        let read = match tokio::time::timeout_at(header_deadline, stream.read(&mut chunk)).await {
            Ok(result) => result?,
            Err(_) => return write_simple(&mut stream, "408 Request Timeout").await,
        };
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let request = String::from_utf8_lossy(&buffer);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method != "GET" {
        return write_simple(&mut stream, "405 Method Not Allowed").await;
    }

    let query = target.splitn(2, '?').nth(1).unwrap_or_default();
    let upstream = query_param(query, "u").map(|v| percent_decode(&v));
    let clen = query_param(query, "clen").and_then(|v| v.parse::<u64>().ok());
    let mime = query_param(query, "mime")
        .map(|v| percent_decode(&v))
        .unwrap_or_else(|| "video/mp4".to_string());
    let (Some(upstream), Some(clen)) = (upstream, clen) else {
        return write_simple(&mut stream, "400 Bad Request").await;
    };
    if !is_allowed_upstream(&upstream) {
        return write_simple(&mut stream, "403 Forbidden").await;
    }
    if !is_safe_mime_type(&mime) {
        return write_simple(&mut stream, "400 Bad Request").await;
    }
    // Some formats come without contentLength; discover the total size with a
    // one-byte probe (cached per URL) so Content-Range stays accurate.
    let clen = if clen > 0 {
        clen
    } else {
        match resolve_total_length(&upstream).await {
            Some(total) => total,
            None => return write_simple(&mut stream, "502 Bad Gateway").await,
        }
    };

    let range_header = lines.take_while(|l| !l.is_empty()).find_map(|l| {
        let (name, value) = l.split_once(':')?;
        name.eq_ignore_ascii_case("range")
            .then(|| value.trim().to_string())
    });
    let (start, requested_end) = parse_range(range_header.as_deref(), clen);
    if start >= clen {
        return write_simple(&mut stream, "416 Range Not Satisfiable").await;
    }
    let end = requested_end
        .unwrap_or(u64::MAX)
        .min(clen - 1)
        .min(start.saturating_add(CHUNK_BYTES - 1));

    let upstream_for_fetch = upstream.clone();
    let body = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let response = agent()
            .get(&upstream_for_fetch)
            .set("Range", &format!("bytes={start}-{end}"))
            .call()
            .map_err(|e| format!("upstream request failed: {e}"))?;
        if response.status() != 206 {
            return Err("upstream did not honor the bounded byte range".to_string());
        }
        let (response_start, response_end, response_total) = response
            .header("Content-Range")
            .and_then(parse_content_range)
            .ok_or_else(|| "upstream returned an invalid Content-Range".to_string())?;
        if response_start != start
            || response_end < response_start
            || response_end > end
            || response_total != clen
        {
            return Err("upstream returned a mismatched Content-Range".to_string());
        }
        let expected_bytes = response_end - response_start + 1;
        let mut bytes = Vec::with_capacity(expected_bytes as usize);
        let mut bounded_reader = std::io::Read::take(response.into_reader(), expected_bytes + 1);
        std::io::Read::read_to_end(&mut bounded_reader, &mut bytes)
            .map_err(|e| format!("upstream read failed: {e}"))?;
        if bytes.len() as u64 != expected_bytes {
            return Err("upstream body length did not match Content-Range".to_string());
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);

    let body = match body {
        Ok(bytes) => bytes,
        Err(err) => {
            log::warn!("[ytproxy] {err}");
            return write_simple(&mut stream, "502 Bad Gateway").await;
        }
    };

    let actual_end = start.saturating_add(body.len().saturating_sub(1) as u64);
    let head = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{actual_end}/{clen}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len(),
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.flush().await
}

static CLEN_CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    OnceLock::new();
const MAX_CACHED_LENGTHS: usize = 128;

async fn resolve_total_length(upstream: &str) -> Option<u64> {
    let cache = CLEN_CACHE.get_or_init(Default::default);
    if let Some(total) = cache.lock().ok().and_then(|map| map.get(upstream).copied()) {
        return Some(total);
    }
    let url = upstream.to_string();
    let total = tokio::task::spawn_blocking(move || -> Option<u64> {
        let response = agent().get(&url).set("Range", "bytes=0-0").call().ok()?;
        if response.status() != 206 {
            return None;
        }
        let (start, end, total) = parse_content_range(response.header("Content-Range")?)?;
        (start == 0 && end == 0 && total > 0).then_some(total)
    })
    .await
    .ok()
    .flatten()?;
    if let Ok(mut map) = cache.lock() {
        if map.len() >= MAX_CACHED_LENGTHS && !map.contains_key(upstream) {
            if let Some(eviction_key) = map.keys().next().cloned() {
                map.remove(&eviction_key);
            }
        }
        map.insert(upstream.to_string(), total);
    }
    Some(total)
}

fn is_allowed_upstream(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.port_or_known_default() == Some(443)
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && host.to_ascii_lowercase().ends_with(".googlevideo.com")
}

fn is_safe_mime_type(mime: &str) -> bool {
    let Some((kind, subtype)) = mime.split_once('/') else {
        return false;
    };
    !kind.is_empty()
        && !subtype.is_empty()
        && mime.len() <= 128
        && mime
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'+' | b'.'))
}

fn parse_content_range(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim().strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let start = start.parse().ok()?;
    let end = end.parse().ok()?;
    let total = total.parse().ok()?;
    (end >= start && total > end).then_some((start, end, total))
}

fn parse_range(header: Option<&str>, clen: u64) -> (u64, Option<u64>) {
    let Some(header) = header else {
        return (0, None);
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return (0, None);
    };
    let spec = spec.split(',').next().unwrap_or_default().trim();
    if let Some(suffix) = spec.strip_prefix('-') {
        // Suffix range: last N bytes.
        let n: u64 = suffix.parse().unwrap_or(0);
        return (clen.saturating_sub(n), None);
    }
    let mut ends = spec.splitn(2, '-');
    let start = ends.next().unwrap_or_default().parse().unwrap_or(0);
    let end = ends.next().unwrap_or_default().parse().ok();
    (start, end)
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(i + 1).and_then(|b| (*b as char).to_digit(16)),
                bytes.get(i + 2).and_then(|b| (*b as char).to_digit(16)),
            ) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn write_simple(stream: &mut TcpStream, status: &str) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.flush().await
}
