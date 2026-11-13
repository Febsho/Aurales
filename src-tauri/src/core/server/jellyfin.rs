use super::{
    CollectionMembershipUpdate, Identity, ReportPlaybackRequest, SaveServerConnectionRequest,
    ScanResult, ServerCatalogItem, ServerConnection, ServerStream,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use std::io::Read;

const CLIENT_HEADER: &str = "MediaBrowser Client=\"Aurales\", Device=\"Desktop\", DeviceId=\"aurales-desktop\", Version=\"0.5.3\"";
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
    let me = match get_json(&request.server_url, "/Users/Me", Some(token)) {
        Ok(user) => user,
        Err(me_error) => {
            // API keys are server-scoped and have no implicit "Me" user. Let
            // users identify the account with the username field already
            // shown in the connection form, then persist that account ID.
            let username = request.username.as_deref().map(str::trim).filter(|name| !name.is_empty())
                .ok_or_else(|| format!("{me_error}. Jellyfin API keys are not tied to a user; enter the Jellyfin username to use for library and watch history access."))?;
            let users = get_json(&request.server_url, "/Users", Some(token))
                .map_err(|_| format!("Could not resolve Jellyfin user '{username}' with this token. Use a user access token or an API key allowed to list users."))?;
            users.as_array().and_then(|users| users.iter().find(|user| {
                user.get("Name").and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(username))
            })).cloned().ok_or_else(|| format!("Jellyfin user '{username}' was not found or is not visible to this API key."))?
        }
    };
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
    let mut path=format!("/Items?Recursive=true&IncludeItemTypes=Movie,Series,Season,Episode,BoxSet&Fields=ProviderIds,Path,Genres,Overview,DateCreated,DateLastSaved,DateLastMediaAdded,ParentId,AncestorIds,SeriesName,SeasonName,IndexNumber,ParentIndexNumber,PremiereDate,EndDate,ProductionYear,CommunityRating,CriticRating,OfficialRating,RunTimeTicks,OriginalTitle,OriginalLanguage,SortName,Taglines,Tags,Studios,People,ProductionLocations,RemoteTrailers,ExternalUrls,ImageTags,BackdropImageTags,ImageBlurHashes,MediaStreams,UserData&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop&Limit={PAGE_SIZE}");
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
    // Jellyfin BoxSets are folders in the collection UI, not playable media.
    // Read their direct children once during indexing and put those movies /
    // series into the named collection catalogs that the app can display.
    let collections: Vec<(String, String)> = items.iter()
        .filter(|item| item.media_type == "collection")
        .filter_map(|item| Some((item.source_item_id.clone(), item.raw.get("Name")?.as_str()?.to_string())))
        .collect();
    let mut collection_updates = Vec::new();
    for (collection_id, collection_name) in collections {
        let Some(member_ids) = collection_member_ids(&connection.server_url, token, user_id, &collection_id) else {
            continue;
        };
        let catalog_id = format!("collection:{collection_name}");
        collection_updates.push(CollectionMembershipUpdate {
            source_item_id: collection_id,
            catalog_id,
            member_item_ids: member_ids,
        });
    }
    Ok(ScanResult {
        items,
        cursor: Some(super::now_cursor()),
        complete,
        collection_updates,
    })
}

fn collection_member_ids(base: &str, token: &str, user_id: Option<&str>, collection_id: &str) -> Option<Vec<String>> {
    const PAGE_SIZE: usize = 1000;
    let mut path = format!(
        "/Items?ParentId={}&Recursive=true&Limit={PAGE_SIZE}&EnableTotalRecordCount=true&Fields=ProviderIds,Path,Genres,Overview,DateCreated,DateLastSaved,ParentId,AncestorIds,PremiereDate,ProductionYear,CommunityRating,CriticRating,OfficialRating,RunTimeTicks,OriginalTitle,OriginalLanguage,SortName,Taglines,Tags,Studios,People,ProductionLocations,RemoteTrailers,ExternalUrls,ImageTags,BackdropImageTags,ImageBlurHashes,MediaStreams,UserData",
        encoded(collection_id),
    );
    if let Some(user_id) = user_id {
        path.push_str("&UserId=");
        path.push_str(&encoded(user_id));
    }
    let mut ids = Vec::new();
    let mut start = 0;
    loop {
        let page_path = format!("{path}&StartIndex={start}");
        let page = get_json(base, &page_path, Some(token)).ok()?;
        let page_items = page.get("Items").and_then(Value::as_array).cloned().unwrap_or_default();
        let page_count = page_items.len();
        ids.extend(page_items.iter().filter_map(|item| item.get("Id").and_then(Value::as_str).map(str::to_string)));
        let total = page.get("TotalRecordCount").and_then(Value::as_u64).map(|value| value as usize);
        start += page_count;
        if page_count == 0 || page_count < PAGE_SIZE || total.is_some_and(|count| start >= count) { break; }
    }
    Some(ids)
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
    let response=ureq::post(&url).timeout(HTTP_TIMEOUT).set("Content-Type","application/json").set("X-Emby-Token",token).set("X-Emby-Authorization",CLIENT_HEADER).send_json(json!({"UserId":user_id,"EnableDirectPlay":true,"EnableDirectStream":true,"EnableTranscoding":true,"AutoOpenLiveStream":false})).map_err(http_error)?;
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
            .unwrap_or(false);
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
        let subtitle_streams: Vec<Value> = streams
            .iter()
            .filter(|v| v.get("Type").and_then(Value::as_str) == Some("Subtitle"))
            .cloned()
            .collect();
        // PlaybackInfo describes embedded subtitle tracks but does not return
        // browser-ready subtitle objects. Expose Jellyfin's subtitle stream
        // endpoint in the same shape the existing player consumes.
        let subtitles: Vec<Value> = subtitle_streams
            .iter()
            .filter_map(|track| {
                let index = track.get("Index")?.as_i64()?;
                let format = track
                    .get("Codec")
                    .and_then(Value::as_str)
                    .filter(|codec| matches!(codec.to_ascii_lowercase().as_str(), "vtt" | "srt" | "ass" | "ssa" | "sub"))
                    .unwrap_or("vtt");
                let subtitle_path = format!(
                    "/Videos/{}/{}/Subtitles/{}/Stream.{}?api_key={}",
                    encoded_path_segment(item_id),
                    encoded_path_segment(source_id),
                    index,
                    format,
                    encoded(token),
                );
                Some(json!({
                    "id": index.to_string(),
                    "url": absolute(&connection.server_url, &subtitle_path),
                    "lang": track.get("Language").and_then(Value::as_str).unwrap_or("und"),
                    "label": track.get("DisplayTitle").and_then(Value::as_str)
                        .or_else(|| track.get("Title").and_then(Value::as_str))
                        .or_else(|| track.get("Language").and_then(Value::as_str))
                        .unwrap_or("Subtitle"),
                    "forced": track.get("IsForced").and_then(Value::as_bool).unwrap_or(false),
                }))
            })
            .collect();
        let title = source
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("Jellyfin")
            .to_string();
        let mut server_stream = ServerStream{addon_id:format!("server:{}",connection.id),addon_name:connection.name.clone(),provider:"jellyfin".into(),connection_id:connection.id.clone(),source_item_id:item_id.into(),name:title.clone(),title,description:Some("Jellyfin direct play / direct stream".into()),filename:source.get("Path").and_then(Value::as_str).and_then(|v|v.rsplit('/').next()).map(str::to_string),url:play_url,headers:vec![("X-Emby-Token".into(),token.into())],direct_play,direct_stream,transcode:false,container,video_codec:video.and_then(|v|v.get("Codec")).and_then(Value::as_str).map(str::to_string),audio_codec:audio.and_then(|v|v.get("Codec")).and_then(Value::as_str).map(str::to_string),resolution:video.and_then(|v|Some(format!("{}x{}",v.get("Width")?.as_i64()?,v.get("Height")?.as_i64()?))),bitrate:source.get("Bitrate").and_then(Value::as_i64),hdr:video.and_then(|v|v.get("VideoRangeType").or_else(||v.get("VideoRange"))).and_then(Value::as_str).map(str::to_string),media_source_id:Some(source_id.into()),play_session_id:source.get("PlaySessionId").or_else(||body.get("PlaySessionId")).and_then(Value::as_str).map(str::to_string),audio_tracks:streams.iter().filter(|v|v.get("Type").and_then(Value::as_str)==Some("Audio")).cloned().collect(),subtitle_tracks:subtitle_streams,subtitles,chapters:chapters.clone(),behavior_hints:json!({"notWebReady":true,"serverProvider":"jellyfin","directPlay":direct_play})};
        if direct_play || direct_stream {
            result.push(server_stream.clone());
        }
        if let Some(transcode_url) = source.get("TranscodingUrl").and_then(Value::as_str)
            .and_then(|candidate| same_origin_url(&connection.server_url, candidate)) {
            if let Ok(mut parsed) = url::Url::parse(&transcode_url) {
                if !parsed.query_pairs().any(|(key, _)| key == "api_key") {
                    parsed.query_pairs_mut().append_pair("api_key", token);
                }
                server_stream.url = parsed.into();
                server_stream.name = format!("{} · Transcode", server_stream.name);
                server_stream.description = source.get("TranscodingContainer").and_then(Value::as_str)
                    .map(|format| format!("Jellyfin transcoded stream ({format})"));
                server_stream.direct_play = false;
                server_stream.direct_stream = false;
                server_stream.transcode = true;
                server_stream.container = source.get("TranscodingContainer").and_then(Value::as_str).map(str::to_string);
                server_stream.behavior_hints = json!({"notWebReady":true,"serverProvider":"jellyfin","directPlay":false,"transcode":true,"transcodingProtocol":source.get("TranscodingSubProtocol").or_else(||source.get("TranscodingProtocol"))});
                result.push(server_stream);
            }
        }
    }
    Ok(result)
}

pub fn report_playback(
    connection: &ServerConnection,
    token: &str,
    request: &ReportPlaybackRequest,
) -> Result<(), String> {
    if token.is_empty() {
        return Err("Jellyfin credentials are missing".into());
    }
    let path = match request.event.as_str() {
        "start" => "/Sessions/Playing",
        "progress" | "pause" | "unpause" => "/Sessions/Playing/Progress",
        "stop" => "/Sessions/Playing/Stopped",
        _ => return Err("Unsupported Jellyfin playback event".into()),
    };
    let payload = match request.event.as_str() {
        "start" => json!({
            "ItemId": request.item_id,
            "MediaSourceId": request.media_source_id,
            "PlaySessionId": request.play_session_id,
            "PositionTicks": request.position_ticks,
            "CanSeek": true,
            "IsPaused": request.is_paused,
            "PlayMethod": request.play_method,
        }),
        "progress" | "pause" | "unpause" => json!({
            "ItemId": request.item_id,
            "MediaSourceId": request.media_source_id,
            "PlaySessionId": request.play_session_id,
            "PositionTicks": request.position_ticks,
            "CanSeek": true,
            "IsPaused": request.is_paused,
            "PlayMethod": request.play_method,
        }),
        "stop" => json!({
            "ItemId": request.item_id,
            "MediaSourceId": request.media_source_id,
            "PlaySessionId": request.play_session_id,
            "PositionTicks": request.position_ticks,
        }),
        _ => unreachable!("event is validated above"),
    };
    let response = ureq::post(&absolute(&connection.server_url, path))
        .timeout(HTTP_TIMEOUT)
        .set("Content-Type", "application/json")
        .set("X-Emby-Token", token)
        .set("X-Emby-Authorization", CLIENT_HEADER)
        .send_json(payload)
        .map_err(http_error)?;
    // The playback endpoints normally return 204 with an empty body.
    drop(response);
    Ok(())
}

pub fn set_item_watched(
    connection: &ServerConnection,
    token: &str,
    user_id: &str,
    item_id: &str,
    watched: bool,
) -> Result<(), String> {
    if token.is_empty() || user_id.is_empty() || item_id.is_empty() {
        return Err("Jellyfin user, item, and access token are required".into());
    }
    let modern_path = format!(
        "/UserPlayedItems/{}?userId={}",
        encoded_path_segment(item_id),
        encoded(user_id)
    );
    let modern_url = absolute(&connection.server_url, &modern_path);
    let modern_request = if watched { ureq::post(&modern_url) } else { ureq::delete(&modern_url) };
    let modern_result = modern_request
        .timeout(HTTP_TIMEOUT)
        .set("X-Emby-Token", token)
        .set("X-Emby-Authorization", CLIENT_HEADER)
        .call();
    match modern_result {
        Ok(response) => {
            drop(response);
            Ok(())
        }
        // Older Jellyfin releases expose only the compatibility route.
        Err(ureq::Error::Status(404, _)) => {
            let legacy_path = format!(
                "/Users/{}/PlayedItems/{}",
                encoded_path_segment(user_id),
                encoded_path_segment(item_id)
            );
            let legacy_url = absolute(&connection.server_url, &legacy_path);
            let request = if watched { ureq::post(&legacy_url) } else { ureq::delete(&legacy_url) };
            request
                .timeout(HTTP_TIMEOUT)
                .set("X-Emby-Token", token)
                .set("X-Emby-Authorization", CLIENT_HEADER)
                .call()
                .map(|response| drop(response))
                .map_err(http_error)
        }
        Err(error) => Err(http_error(error)),
    }
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
    let genre_marks_anime = genres.iter().any(|g| {
        g.as_str()
            .map(|v| v.eq_ignore_ascii_case("anime"))
            .unwrap_or(false)
    });
    let tmdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Tmdb"));
    let tvdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Tvdb"));
    let imdb_id = raw.get("ProviderIds").and_then(|v| id_value(v, "Imdb"));
    let anilist_id = raw
        .get("ProviderIds")
        .and_then(|v| id_value(v, "AniList").or_else(|| id_value(v, "Anilist")));
    let mal_id = raw
        .get("ProviderIds")
        .and_then(|v| id_value(v, "MyAnimeList").or_else(|| id_value(v, "Mal")));
    // Jellyfin metadata providers often populate AniList/MAL without adding
    // an explicit "Anime" genre. Preserve that provider signal for anime
    // shelves, detail routing, and the tracker metadata passed to services.
    let is_anime = genre_marks_anime || anilist_id.is_some() || mal_id.is_some();
    if is_anime && !catalogs.iter().any(|catalog| catalog == "anime") {
        catalogs.push("anime".into());
    }
    // Only advertise Jellyfin image endpoints when the item actually has that
    // image. Fabricating these URLs for missing ImageTags made Home cards treat
    // a 404 as valid artwork and prevented their provider/backdrop fallbacks.
    let has_primary_image = raw
        .pointer("/ImageTags/Primary")
        .and_then(Value::as_str)
        .is_some_and(|tag| !tag.is_empty());
    let has_backdrop_image = raw
        .get("BackdropImageTags")
        .and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str().is_some_and(|tag| !tag.is_empty())));
    let poster = has_primary_image.then(|| format!(
        "/Items/{}/Images/Primary?fillHeight=900&quality=90",
        encoded_path_segment(&id)
    ));
    let backdrop = has_backdrop_image.then(|| format!(
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
        .or(imdb_id.clone())
        .unwrap_or_else(|| id.clone());
    let item_type = if media_type == "episode" {
        "series".into()
    } else {
        media_type.clone()
    };
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
        overview: raw.get("Overview").and_then(Value::as_str).map(str::to_string),
        rating: raw.get("CommunityRating").and_then(Value::as_f64),
        critic_rating: raw.get("CriticRating").and_then(Value::as_f64),
        runtime: raw.get("RunTimeTicks").and_then(Value::as_i64).map(|ticks| ticks / 10_000_000),
        release_date: raw.get("PremiereDate").and_then(Value::as_str).map(str::to_string),
        original_title: raw.get("OriginalTitle").and_then(Value::as_str).map(str::to_string),
        certification: raw.get("OfficialRating").and_then(Value::as_str).map(str::to_string),
        tagline: raw.get("Taglines").and_then(Value::as_array).and_then(|values| values.iter().find_map(Value::as_str)).map(str::to_string),
        genres: super::json_string_array(&raw, "Genres"),
        studios: raw.get("Studios").and_then(Value::as_array).map(|values| values.iter().filter_map(|value| value.get("Name").and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default(),
        people: raw.get("People").and_then(Value::as_array).cloned().unwrap_or_default(),
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
