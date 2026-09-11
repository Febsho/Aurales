//! Native application-domain services.
//!
//! Tauri commands remain thin adapters; functionality that is migrated from
//! the frontend belongs in a focused module here so it can be tested without a
//! running webview.
pub mod addon_catalog;
pub mod addon_meta;
pub mod anime;
pub mod anime_lookup;
pub mod anime_season;
pub mod cache;
pub mod catalog;
pub mod detail_page;
pub mod discord;
pub mod metadata;
pub mod platform;
pub mod player;
pub mod providers;
pub mod request;
pub mod settings;
pub mod stream_candidates;
pub mod streams;
pub mod subtitles;
pub mod sync;
