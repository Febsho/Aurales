use super::{
    Identity, SaveServerConnectionRequest, ScanResult, ServerCatalogItem, ServerConnection,
    ServerStream,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::io::Read;

const CLIENT_HEADER: &str = "MediaBrowser Client=\"Aurales\", Device=\"Desktop\", DeviceId=\"aurales-desktop\", Version=\"0.4.1\"";
const HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const MAX_JSON_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

pub fn test(
    request: &SaveServerConnectionRequest,
    secret: Option<&str>,
) -> Result<Identity, String> {
    let public: Value = get_json(&request.server_url, "/System/Info/Public", None)?;
    let server_name = public
        .get("ServerName")
        .and_then(Value::as_str)
        .map(str::to_string);
    if request.auth_mode.eq_ignore_ascii_case("password") {
        let username = request
            .username
            .as_deref()
            .ok_or_else(|| "Jellyfin username is required".to_string())?;
        let password = secret.ok_or_else(|| "Jellyfin password is required".to_string())?;
        let url = format!("{}/Users/AuthenticateByName", request.server_url);
        let response = ureq::post(&url)
            .timeout(HTTP_TIMEOUT)
            .set("Content-Type", "application/json")
            .set("X-Emby-Authorization", CLIENT_HEADER)
            .send_json(json!({"Username":username,"Pw":password}))
            .map_err(http_error)?;
        let body = read_json_response(response)?;
        let token = body
            .get("AccessToken")
            .and_then(Value::as_str)
            .ok_or_else(|| "Jellyfin did not return an access token".to_string())?
            .to_string();
        let user = body.get("User").unwrap_or(&Value::Null);
        return Ok(Identity {
            server_name,
            user_name: user.get("Name").and_then(Value::as_str).map(str::to_string),
            access_token: Some(token),
            user_id: user.get("Id").and_then(Value::as_str).map(str::to_string),
        });
    }
    let token = secret.ok_or_else(|| "Jellyfin access token/API key is required".to_string())?;
    let me: Value = get_json(&request.server_url, "/Users/Me", Some(token))?;
    Ok(Identity {
        server_name,
        user_name: me.get("Name").and_then(Value::as_str).map(str::to_string),
        access_token: None,
        user_id: me.get("Id").and_then(Value::as_str).map(str::to_string),
    })
}

pub fn scan(
    connection: &ServerConnection,
    token: &str,
    user_id: Option<&str>,
    cursor: Option<&str>,
) -> Result<ScanResult, String> {
    if token.is_empty() {
        return Err("Jellyfin credentials are missing".into());
    }
    const PAGE_SIZE: usize = 1000;
    let mut path=format!("/Items?Recursive=true&IncludeItemTypes=Movie,Series,Season,Episode,BoxSet&Fields=ProviderIds,Path,Genres,Overview,DateCreated,DateLastSaved,ParentId,AncestorIds,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,PremiereDate,UserData&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop&Limit={PAGE_SIZE}");
    if let Some(user) = user_id {
        path.push_str("&UserId=");
        path.push_str(&encoded(user));
    }
    // Jellyfin supports MinDateLastSaved on modern servers. If an older server
    // rejects it, retry as a complete refresh rather than failing the provider.
    let (first_page, page_path, complete) = if let Some(cursor) = cursor {
        let incremental = format!("{path}&MinDateLastSaved={}", encoded(cursor));
        match get_json(
            &connection.server_url,
            &format!("{incremental}&StartIndex=0"),
            Some(token),
        ) {
            Ok(v) => (v, incremental, false),
            Err(_) => (
                get_json(
                    &connection.server_url,
                    &format!("{path}&StartIndex=0"),
                    Some(token),
                )?,
                path.clone(),
                true,
            ),
        }
    } else {
        (
            get_json(
                &connection.server_url,
                &format!("{path}&StartIndex=0"),
                Some(token),
            )?,
            path.clone(),
            true,
        )
    };
    let mut raw_items = first_page
        .get("Items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next_start = raw_items.len();
    let mut last_page_count = raw_items.len();
    let mut total = first_page
        .get("TotalRecordCount")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    while total.map_or(last_page_count == PAGE_SIZE, |count| next_start < count) {
        let page_url = format!("{page_path}&StartIndex={next_start}");
        let page = get_json(&connection.server_url, &page_url, Some(token))?;
        let page_items = page
            .get("Items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(count) = page.get("TotalRecordCount").and_then(Value::as_u64) {
            total = Some(count as usize);
        }
        if page_items.is_empty() {
            break;
        }
        last_page_count = page_items.len();
        next_start += page_items.len();
        raw_items.extend(page_items);
    }
    let mut items = Vec::new();
    for raw in raw_items {
        if let Some(item) = catalog_item(connection, raw) {
            items.push(item)
        }
    }
    // Virtual folders become native library catalog memberships.
    if let Ok(folders) = get_json(
        &connection.server_url,
        "/Library/VirtualFolders",
        Some(token),
    ) {
        if let Some(folders) = folders.as_array() {
            for folder in folders {
                let name = folder
                    .get("Name")
                    .and_then(Value::as_str)
                    .unwrap_or("Library");
                let collection = folder
                    .get("CollectionType")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let folder_id = folder.get("ItemId").and_then(Value::as_str);
                for item in &mut items {
                    let belongs_to_folder = folder_id.is_some_and(|folder_id| {
                        item.raw
                            .get("AncestorIds")
                            .and_then(Value::as_array)
                            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(folder_id)))
                            || item.raw.get("ParentId").and_then(Value::as_str) == Some(folder_id)
                    });
                    let matches_collection_type = !collection.is_empty()
                        && item.raw.get("CollectionType").and_then(Value::as_str)
                            == Some(collection);
                    if belongs_to_folder || matches_collection_type {
                        item.catalog_ids.push(format!("library:{name}"));
                    }
                }
            }
        }
    }
    Ok(ScanResult {
        items,
        cursor: Some(super::now_cursor()),
        complete,
    })
}

pub fn streams(
    connection: &ServerConnection,
    token: &str,
    user_id: Option<&str>,
    item_id: &str,
) -> Result<Vec<ServerStream>, String> {
    if token.is_empty() {
        return Err("Jellyfin credentials are missing".into());
    }
    let path = format!(
        "/Items/{}/PlaybackInfo{}",
        encoded_path_segment(item_id),
        user_id
            .map(|v| format!("?UserId={}", encoded(v)))
            .unwrap_or_default()
    );
    let url = format!("{}{}", connection.server_url, path);
    let response=ureq::post(&url).timeout(HTTP_TIMEOUT).set("Content-Type","application/json").set("X-Emby-Token",token).set("X-Emby-Authorization",CLIENT_HEADER).send_json(json!({"UserId":user_id,"EnableDirectPlay":true,"EnableDirectStream":true,"EnableTranscoding":false,"AutoOpenLiveStream":false})).map_err(http_error)?;
    let body = read_json_response(response)?;
    let chapters = body
        .get("Chapters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut result = Vec::new();
    for source in body
        .get("MediaSources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let source_id = source.get("Id").and_then(Value::as_str).unwrap_or(item_id);
        let container = source
            .get("Container")
            .and_then(Value::as_str)
            .map(str::to_string);
        let streams = source
            .get("MediaStreams")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let video = streams
            .iter()
            .find(|v| v.get("Type").and_then(Value::as_str) == Some("Video"));
        let audio = streams
            .iter()
            .find(|v| v.get("Type").and_then(Value::as_str) == Some("Audio"));
        let fallback_path = format!(
            "/Videos/{}/stream?Static=true&MediaSourceId={}",
            encoded_path_segment(item_id),
            encoded(source_id)
        );
        let direct_play = source
            .get("SupportsDirectPlay")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let direct_stream = source
            .get("SupportsDirectStream")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        // DirectStreamUrl comes from the server response. Never attach the
        // stored API token to a URL on another origin.
        let mut play_url = source
            .get("DirectStreamUrl")
            .and_then(Value::as_str)
            .and_then(|candidate| same_origin_url(&connection.server_url, candidate))
            .unwrap_or_else(|| absolute(&connection.server_url, &fallback_path));
        let Ok(mut parsed_play_url) = url::Url::parse(&play_url) else {
            continue;
        };
        parsed_play_url
            .query_pairs_mut()
            .append_pair("api_key", token);
        play_url = parsed_play_url.into();
        let subtitle_tracks: Vec<Value> = streams
            .iter()
            .filter(|v| v.get("Type").and_then(Value::as_str) == Some("Subtitle"))
            .cloned()
            .collect();
        let title = source
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Jellyfin")
            .to_string();
        result.push(ServerStream{addon_id:format!("server:{}",connection.id),addon_name:connection.name.clone(),provider:"jellyfin".into(),connection_id:connection.id.clone(),source_item_id:item_id.into(),name:title.clone(),title,description:Some("Jellyfin direct play".into()),filename:source.get("Path").and_then(Value::as_str).and_then(|v|v.rsplit('/').next()).map(str::to_string),url:play_url,headers:vec![("X-Emby-Token".into(),token.into())],direct_play,direct_stream,transcode:false,container,video_codec:video.and_then(|v|v.get("Codec")).and_then(Value::as_str).map(str::to_string),audio_codec:audio.and_then(|v|v.get("Codec")).and_then(Value::as_str).map(str::to_string),resolution:video.and_then(|v|Some(format!("{}x{}",v.get("Width")?.as_i64()?,v.get("Height")?.as_i64()?))),bitrate:source.get("Bitrate").and_then(Value::as_i64),hdr:video.and_then(|v|v.get("VideoRangeType").or_else(||v.get("VideoRange"))).and_then(Value::as_str).map(str::to_string),media_source_id:Some(source_id.into()),audio_tracks:streams.iter().filter(|v|v.get("Type").and_then(Value::as_str)==Some("Audio")).cloned().collect(),subtitle_tracks:subtitle_tracks.clone(),subtitles:subtitle_tracks,chapters:chapters.clone(),behavior_hints:json!({"notWebReady":true,"serverProvider":"jellyfin","directPlay":direct_play})});
    }
    Ok(result)
}

fn catalog_item(connection: &ServerConnection, raw: Value) -> Option<ServerCatalogItem> {
    let id = raw.get("Id")?.as_str()?.to_string();
    let kind = raw.get("Type")?.as_str()?;
    let media_type = match kind {
        "Movie" => "movie",
        "Series" => "series",
        "Season" => "season",
        "Episode" => "episode",
        "BoxSet" => "collection",
        _ => return None,
    }
    .to_string();
    let mut catalogs = vec![match kind {
        "Movie" => "movies",
        "Series" => "series",
        "Season" => "seasons",
        "Episode" => "episodes",
        "BoxSet" => "collections",
        _ => "mixed",
    }
    .into()];
    // Keep each Jellyfin BoxSet as its own selectable catalog instead of
    // flattening every server-side collection into one anonymous bucket.
    if kind == "BoxSet" {
        if let Some(name) = raw
            .get("Name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
        {
            catalogs.push(format!("collection:{name}"));
        }
    }
    let user = raw.get("UserData").unwrap_or(&Value::Null);
    if user
        .get("PlaybackPositionTicks")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        > 0
        && !user.get("Played").and_then(Value::as_bool).unwrap_or(false)
    {
        catalogs.push("continue-watching".into())
    }
    if user
        .get("IsFavorite")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        catalogs.push("favorites".into())
    }
    let recently_added = raw
        .get("DateCreated")
        .and_then(Value::as_str)
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .is_some_and(|created| created.with_timezone(&Utc) >= Utc::now() - Duration::days(30));
    if recently_added {
        catalogs.push("recently-added".into())
    }
    let genres = raw
        .get("Genres")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if genres.iter().any(|g| {
        g.as_str()
            .map(|v| v.eq_ignore_ascii_case("anime"))
            .unwrap_or(false)
    }) {
        catalogs.push("anime".into())
    }
    let tmdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Tmdb"));
    let tvdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Tvdb"));
    let imdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Imdb"));
    let anilist_id = raw
        .get("ProviderIds")
        .and_then(|v| id_value(v, "AniList").or_else(|| id_value(v, "Anilist")));
    let mal_id = raw
        .get("ProviderIds")
        .and_then(|v| id_value(v, "MyAnimeList").or_else(|| id_value(v, "Mal")));
    let poster = Some(format!(
        "/Items/{}/Images/Primary?fillHeight=900&quality=90",
        encoded_path_segment(&id)
    ));
    let backdrop = Some(format!(
        "/Items/{}/Images/Backdrop?fillHeight=900&quality=90",
        encoded_path_segment(&id)
    ));
    let mut raw = raw;
    if let Some(object) = raw.as_object_mut() {
        object.insert(
            "serverUrl".into(),
            Value::String(connection.server_url.clone()),
        );
    }
    let canonical_id = tmdb_id
        .clone()
        .or(tvdb_id.clone())
        .or(anilist_id.clone())
        .unwrap_or_else(|| id.clone());
    let item_type = if media_type == "episode" {
        "series".into()
    } else {
        media_type.clone()
    };
    let is_anime = catalogs.iter().any(|v| v == "anime");
    Some(ServerCatalogItem {
        connection_id: connection.id.clone(),
        source_connection_id: connection.id.clone(),
        source_addon_id: format!("server:{}", connection.id),
        source_addon_item_id: id.clone(),
        provider: "jellyfin".into(),
        id: canonical_id,
        item_type,
        is_anime,
        source_item_id: id,
        catalog_ids: catalogs,
        media_type,
        title: raw
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .into(),
        year: raw.get("ProductionYear").and_then(Value::as_i64),
        season: raw.get("ParentIndexNumber").and_then(Value::as_i64),
        episode: raw.get("IndexNumber").and_then(Value::as_i64),
        parent_source_item_id: raw
            .get("ParentId")
            .and_then(Value::as_str)
            .map(str::to_string),
        tmdb_id,
        tvdb_id,
        imdb_id,
        anilist_id,
        mal_id,
        poster,
        backdrop,
        raw,
    })
}

fn id_value(ids: &Value, key: &str) -> Option<String> {
    ids.get(key).and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_i64().map(|v| v.to_string()))
    })
}
fn encoded(v: &str) -> String {
    url::form_urlencoded::byte_serialize(v.as_bytes()).collect()
}
fn encoded_path_segment(v: &str) -> String {
    // `+` is a space only in query/form encoding. In a URL path it is a literal
    // plus, so convert the query encoder's spaces to their path representation.
    encoded(v).replace('+', "%20")
}
fn absolute(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.into()
    } else {
        format!(
            "{}{}",
            base.trim_end_matches('/'),
            if path.starts_with('/') {
                path.to_string()
            } else {
                format!("/{path}")
            }
        )
    }
}
fn same_origin_url(base: &str, candidate: &str) -> Option<String> {
    let base_url = url::Url::parse(base).ok()?;
    let resolved = base_url.join(candidate).ok()?;
    if resolved.origin() != base_url.origin()
        || !resolved.username().is_empty()
        || resolved.password().is_some()
    {
        return None;
    }
    Some(resolved.into())
}
fn get_json(base: &str, path: &str, token: Option<&str>) -> Result<Value, String> {
    let mut req = ureq::get(&absolute(base, path))
        .timeout(HTTP_TIMEOUT)
        .set("Accept", "application/json")
        .set("X-Emby-Authorization", CLIENT_HEADER);
    if let Some(token) = token {
        req = req.set("X-Emby-Token", token)
    }
    let response = req.call().map_err(http_error)?;
    read_json_response(response)
}
fn read_json_response(response: ureq::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_JSON_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read Jellyfin response: {error}"))?;
    if bytes.len() as u64 > MAX_JSON_RESPONSE_BYTES {
        return Err("Jellyfin response exceeded the 64 MiB limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("Invalid Jellyfin response: {error}"))
}
fn http_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            format!("Jellyfin returned HTTP {code}: {}", response.status_text())
        }
        ureq::Error::Transport(error) => format!("Could not reach Jellyfin: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn joins_server_paths_without_double_slashes() {
        assert_eq!(absolute("https://x/", "/Items"), "https://x/Items");
    }
    #[test]
    fn encodes_item_ids() {
        assert_eq!(encoded("a/b c"), "a%2Fb+c");
    }
}
