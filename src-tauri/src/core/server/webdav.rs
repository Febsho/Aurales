use super::{
    Identity, SaveServerConnectionRequest, ScanResult, ServerCatalogItem, ServerConnection,
    ServerStream,
};
use base64::Engine;
use quick_xml::events::Event;
use quick_xml::Reader;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

pub fn test(
    request: &SaveServerConnectionRequest,
    secret: Option<&str>,
) -> Result<Identity, String> {
    let username = request.username.as_deref().unwrap_or("");
    let url = collection_url(&request.server_url, request.base_directory.as_deref());
    propfind(&url, username, secret.unwrap_or(""), "0")?;
    Ok(Identity {
        server_name: url::Url::parse(&request.server_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string)),
        user_name: request.username.clone(),
        access_token: None,
        user_id: None,
    })
}

pub fn scan(
    connection: &ServerConnection,
    secret: &str,
    _cursor: Option<&str>,
) -> Result<ScanResult, String> {
    let url = collection_url(&connection.server_url, connection.base_directory.as_deref());
    let username = connection.username.as_deref().unwrap_or("");
    let resources =
        match propfind(&url, username, secret, "infinity").and_then(|v| parse_multistatus(&v)) {
            Ok(v) => v,
            Err(_) => recursive_propfind(&url, username, secret)?,
        };
    let mut items = Vec::new();
    let mut shows = HashMap::<String, ServerCatalogItem>::new();
    for resource in resources
        .into_iter()
        .filter(|r| !r.collection && is_video(&r.href))
    {
        if let Some(mut item) = catalog_item(connection, resource) {
            if item.media_type == "episode" {
                if let Some((show_title, anime)) =
                    show_identity(item.raw.get("href").and_then(Value::as_str).unwrap_or(""))
                {
                    let show_id = stable_id(&format!("show:{show_title}"));
                    item.parent_source_item_id = Some(show_id.clone());
                    item.catalog_ids =
                        vec!["episodes".into(), format!("library:{}", connection.name)];
                    shows
                        .entry(show_id.clone())
                        .or_insert_with(|| ServerCatalogItem {
                            connection_id: connection.id.clone(),
                            source_connection_id: connection.id.clone(),
                            source_addon_id: format!("server:{}", connection.id),
                            source_addon_item_id: show_id.clone(),
                            provider: "webdav".into(),
                            id: show_id.clone(),
                            item_type: "series".into(),
                            is_anime: anime,
                            source_item_id: show_id,
                            catalog_ids: vec![
                                if anime {
                                    "anime".into()
                                } else {
                                    "series".into()
                                },
                                format!("library:{}", connection.name),
                            ],
                            media_type: "series".into(),
                            title: show_title,
                            year: None,
                            season: None,
                            episode: None,
                            parent_source_item_id: None,
                            tmdb_id: None,
                            tvdb_id: None,
                            imdb_id: None,
                            anilist_id: None,
                            mal_id: None,
                            poster: None,
                            backdrop: None,
                            raw: json!({"synthetic":true}),
                        });
                }
            }
            items.push(item)
        }
    }
    items.extend(shows.into_values());
    // PROPFIND is a tree listing, but ETags prevent downstream metadata work
    // for unchanged files and the cached result is always served immediately.
    Ok(ScanResult {
        items,
        cursor: Some(super::now_cursor()),
        complete: true,
    })
}

pub fn streams(
    connection: &ServerConnection,
    secret: &str,
    item: &ServerCatalogItem,
) -> Result<Vec<ServerStream>, String> {
    let href = item
        .raw
        .get("href")
        .and_then(Value::as_str)
        .ok_or_else(|| "WebDAV item has no resource URL".to_string())?;
    let mut url = absolute_href(&connection.server_url, href);
    let username = connection.username.as_deref().unwrap_or("");
    let mut headers = Vec::new();
    if !username.is_empty() || !secret.is_empty() {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{secret}"));
        headers.push(("Authorization".into(), format!("Basic {encoded}")));
        if let Ok(mut parsed) = url::Url::parse(&url) {
            let _ = parsed.set_username(username);
            let _ = parsed.set_password(Some(secret));
            url = parsed.into();
        }
    }
    let (container, video_codec) = extension_metadata(href);
    Ok(vec![ServerStream {
        addon_id: format!("server:{}", connection.id),
        addon_name: connection.name.clone(),
        provider: "webdav".into(),
        connection_id: connection.id.clone(),
        source_item_id: item.source_item_id.clone(),
        name: item.title.clone(),
        title: item.title.clone(),
        description: Some("WebDAV direct stream".into()),
        filename: href.rsplit('/').next().map(str::to_string),
        url,
        headers,
        direct_play: true,
        direct_stream: true,
        transcode: false,
        container,
        video_codec,
        audio_codec: None,
        resolution: None,
        bitrate: None,
        hdr: None,
        media_source_id: Some(item.source_item_id.clone()),
        audio_tracks: Vec::new(),
        subtitle_tracks: Vec::new(),
        subtitles: Vec::new(),
        chapters: Vec::new(),
        behavior_hints: json!({"notWebReady":true,"serverProvider":"webdav","supportsRangeRequests":true}),
    }])
}

#[derive(Default, Debug)]
struct Resource {
    href: String,
    content_type: Option<String>,
    length: Option<i64>,
    etag: Option<String>,
    last_modified: Option<String>,
    collection: bool,
}

fn propfind(url: &str, username: &str, password: &str, depth: &str) -> Result<String, String> {
    let mut request = ureq::request("PROPFIND", url)
        .set("Depth", depth)
        .set("Content-Type", "application/xml");
    if !username.is_empty() || !password.is_empty() {
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
        request = request.set("Authorization", &format!("Basic {encoded}"))
    }
    let body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>"#;
    let response = request.send_string(body).map_err(http_error)?;
    response.into_string().map_err(|e| e.to_string())
}

fn recursive_propfind(root: &str, username: &str, password: &str) -> Result<Vec<Resource>, String> {
    let mut queue = VecDeque::from([root.to_string()]);
    let mut visited = HashSet::new();
    let mut files = Vec::new();
    while let Some(url) = queue.pop_front() {
        if !visited.insert(url.clone()) {
            continue;
        }
        if visited.len() > 10_000 {
            return Err("WebDAV directory traversal exceeded 10,000 folders".into());
        }
        let xml = propfind(&url, username, password, "1")?;
        for resource in parse_multistatus(&xml)? {
            let absolute = absolute_href(root, &resource.href);
            if resource.collection && absolute.trim_end_matches('/') != url.trim_end_matches('/') {
                queue.push_back(absolute)
            } else if !resource.collection {
                files.push(resource)
            }
        }
    }
    Ok(files)
}

fn parse_multistatus(xml: &str) -> Result<Vec<Resource>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut resources = Vec::new();
    let mut current: Option<Resource> = None;
    let mut field = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
                if tag == "response" {
                    current = Some(Resource::default())
                } else if tag == "collection" {
                    if let Some(r) = current.as_mut() {
                        r.collection = true
                    }
                } else {
                    field = tag
                }
            }
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref().eq_ignore_ascii_case(b"collection") {
                    if let Some(r) = current.as_mut() {
                        r.collection = true
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(r) = current.as_mut() {
                    let text = e.unescape().map_err(|e| e.to_string())?.into_owned();
                    match field.as_str() {
                        "href" => r.href = text,
                        "getcontenttype" => r.content_type = Some(text),
                        "getcontentlength" => r.length = text.parse().ok(),
                        "getetag" => r.etag = Some(text),
                        "getlastmodified" => r.last_modified = Some(text),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
                if tag == "response" {
                    if let Some(r) = current.take() {
                        if !r.href.is_empty() {
                            resources.push(r)
                        }
                    }
                }
                field.clear()
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("Invalid WebDAV response: {e}")),
            _ => {}
        }
    }
    Ok(resources)
}

fn catalog_item(connection: &ServerConnection, resource: Resource) -> Option<ServerCatalogItem> {
    let decoded = resource.href.replace("%20", " ");
    let filename = decoded.rsplit('/').find(|v| !v.is_empty())?;
    let stem = filename.rsplit_once('.').map(|v| v.0).unwrap_or(filename);
    let episode_re = Regex::new(r"(?i)(?P<title>.*?)[ ._-]+S(?P<s>\d{1,3})E(?P<e>\d{1,4})").ok()?;
    let movie_re = Regex::new(r"(?i)(?P<title>.*?)[ ._-]*\((?P<year>19\d{2}|20\d{2})\)").ok()?;
    let (media_type, title, year, season, episode, mut catalogs) =
        if let Some(c) = episode_re.captures(stem) {
            let title = clean_title(c.name("title").map(|v| v.as_str()).unwrap_or(stem));
            let anime = decoded.to_ascii_lowercase().contains("anime");
            (
                "episode",
                title,
                None,
                c.name("s").and_then(|v| v.as_str().parse().ok()),
                c.name("e").and_then(|v| v.as_str().parse().ok()),
                if anime {
                    vec!["episodes".into(), "anime".into()]
                } else {
                    vec!["episodes".into(), "series".into()]
                },
            )
        } else if let Some(c) = movie_re.captures(stem) {
            (
                "movie",
                clean_title(c.name("title").map(|v| v.as_str()).unwrap_or(stem)),
                c.name("year").and_then(|v| v.as_str().parse().ok()),
                None,
                None,
                vec!["movies".into()],
            )
        } else {
            (
                "movie",
                clean_title(stem),
                None,
                None,
                None,
                vec!["movies".into()],
            )
        };
    catalogs.push(format!("library:{}", connection.name));
    let href = resource.href;
    let source_item_id = stable_id(&href);
    Some(ServerCatalogItem {
        connection_id: connection.id.clone(),
        source_connection_id: connection.id.clone(),
        source_addon_id: format!("server:{}", connection.id),
        source_addon_item_id: source_item_id.clone(),
        provider: "webdav".into(),
        id: source_item_id.clone(),
        item_type: if media_type == "episode" {
            "series".into()
        } else {
            media_type.into()
        },
        is_anime: catalogs.iter().any(|v| v == "anime"),
        source_item_id,
        catalog_ids: catalogs,
        media_type: media_type.into(),
        title,
        year,
        season,
        episode,
        parent_source_item_id: None,
        tmdb_id: None,
        tvdb_id: None,
        imdb_id: None,
        anilist_id: None,
        mal_id: None,
        poster: None,
        backdrop: None,
        raw: json!({"href":href,"contentType":resource.content_type,"contentLength":resource.length,"etag":resource.etag,"lastModified":resource.last_modified,"updatedMarker":resource.etag.as_deref().or(resource.last_modified.as_deref())}),
    })
}

fn collection_url(base: &str, directory: Option<&str>) -> String {
    match directory {
        Some(v) => format!("{}/{}", base.trim_end_matches('/'), v.trim_matches('/')),
        None => base.trim_end_matches('/').into(),
    }
}
fn absolute_href(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.into()
    } else if let Ok(origin) = url::Url::parse(base) {
        origin
            .join(href)
            .map(|v| v.into())
            .unwrap_or_else(|_| format!("{}{}", base.trim_end_matches('/'), href))
    } else {
        href.into()
    }
}
fn is_video(path: &str) -> bool {
    matches!(
        path.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mkv"
            | "mp4"
            | "m4v"
            | "avi"
            | "mov"
            | "webm"
            | "ts"
            | "m2ts"
            | "mpg"
            | "mpeg"
            | "wmv"
            | "flv"
            | "ogv"
    )
}
fn clean_title(value: &str) -> String {
    value
        .replace(['.', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(&['-', ' '][..])
        .to_string()
}
fn show_identity(path: &str) -> Option<(String, bool)> {
    let decoded = path.replace("%20", " ");
    let parts: Vec<_> = decoded.split('/').filter(|v| !v.is_empty()).collect();
    let season_pos = parts
        .iter()
        .position(|v| v.to_ascii_lowercase().starts_with("season "));
    let raw = season_pos
        .and_then(|i| i.checked_sub(1).and_then(|p| parts.get(p).copied()))
        .or_else(|| parts.get(parts.len().saturating_sub(2)).copied())?;
    Some((
        clean_title(raw),
        decoded.to_ascii_lowercase().contains("anime"),
    ))
}
fn stable_id(value: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut h);
    format!("webdav-{:016x}", h.finish())
}
fn extension_metadata(path: &str) -> (Option<String>, Option<String>) {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let codec = match ext.as_str() {
        "webm" => Some("vp9".into()),
        _ => None,
    };
    (if ext.is_empty() { None } else { Some(ext) }, codec)
}
fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            format!("WebDAV returned HTTP {code}: {}", response.status_text())
        }
        ureq::Error::Transport(error) => format!("Could not reach WebDAV server: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_dav_resources_and_ignores_collections() {
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/Movies/A%20Film%20(2026).mkv</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:getetag>abc</d:getetag></d:prop></d:propstat></d:response><d:response><d:href>/Movies/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>"#;
        let r = parse_multistatus(xml).unwrap();
        assert_eq!(r.len(), 2);
        assert!(!r[0].collection);
        assert!(r[1].collection);
    }
    #[test]
    fn recognizes_supported_media_only() {
        assert!(is_video("x.MKV"));
        assert!(!is_video("poster.jpg"));
    }
    #[test]
    fn parses_episode_names() {
        let c = ServerConnection {
            id: "x".into(),
            kind: "webdav".into(),
            name: "x".into(),
            server_url: "https://x".into(),
            username: None,
            auth_mode: "password".into(),
            base_directory: None,
            enabled: true,
            status: "unknown".into(),
            has_secret: false,
            last_error: None,
            server_name: None,
            user_name: None,
            last_tested_at: None,
            last_refreshed_at: None,
        };
        let i = catalog_item(
            &c,
            Resource {
                href: "/Anime Name/Season 01/Anime.Name.S01E03.mkv".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(i.season, Some(1));
        assert_eq!(i.episode, Some(3));
        assert!(i.catalog_ids.contains(&"anime".into()));
    }
}
