// The channel the app's updates come from, and the feed each channel is read from.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// The tags of the pre-releases whose assets each preview and each nightly replace (docs/desktop.md, 「Releases」).
const PREVIEW_TAG: &str = "desktop-preview";
const NIGHTLY_TAG: &str = "desktop-nightly";

/// The channel the app's updates come from (docs/desktop.md, 「The update channel」): the set's stable releases
/// alone, its alphas, betas and release candidates as well, or every kind, the day's build between releases among
/// them. A file that names none runs on stable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
  #[default]
  Stable,
  Preview,
  Nightly,
}

impl Channel {
  /// The channel's name, as a feed's address and the settings file write it.
  fn name(self) -> &'static str {
    match self {
      Self::Stable => "stable",
      Self::Preview => "preview",
      Self::Nightly => "nightly",
    }
  }
}

/// Each channel's updater feed: the configuration's own endpoint for stable, and for preview and nightly the same
/// address with the channel's name where the endpoint is an update server's, or the same file of the channel's
/// pre-release where it is a repository's latest release feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feeds {
  stable: Url,
  preview: Url,
  nightly: Url,
}

impl Feeds {
  /// The feeds beside the stable one: an update server's, or a repository's latest release's.
  pub fn beside(stable: Url) -> Result<Self, String> {
    Self::of_update_server(&stable).map_or_else(|| Self::of_repository(stable), Ok)
  }

  /// The feeds of an update server whose stable endpoint `stable` is, as
  /// `<address>/updates/<product>/stable/{{target}}/{{arch}}/{{current_version}}`, a query after it kept: each other
  /// channel's feed names that channel instead.
  fn of_update_server(stable: &Url) -> Option<Self> {
    let segments: Vec<&str> = stable.path_segments()?.collect();
    let at = segments.len().checked_sub(6)?;
    let [updates, product, "stable", target, arch, version] = segments[at..] else {
      return None;
    };
    let templates = ["%7B%7Btarget%7D%7D", "%7B%7Barch%7D%7D", "%7B%7Bcurrent_version%7D%7D"];
    if updates != "updates" || product.is_empty() || [target, arch, version] != templates {
      return None;
    }
    let on = |channel: Channel| {
      let mut channel_segments = segments.clone();
      channel_segments[at + 2] = channel.name();
      let mut feed = stable.clone();
      feed.set_path(&channel_segments.join("/"));
      feed
    };
    Some(Self {
      stable: stable.clone(),
      preview: on(Channel::Preview),
      nightly: on(Channel::Nightly),
    })
  }

  /// The feeds of the repository whose latest release's asset `stable` names, as
  /// `https://github.com/<owner>/<repository>/releases/latest/download/<file>`; each other channel's feed is that
  /// file of the channel's pre-release.
  fn of_repository(stable: Url) -> Result<Self, String> {
    let segments: Vec<&str> = stable.path_segments().map(Iterator::collect).unwrap_or_default();
    let [owner, repository, "releases", "latest", "download", file] = segments[..] else {
      return Err(format!(
        "the stable feed {stable} is neither an update server's nor a latest release's asset"
      ));
    };
    if file.is_empty() {
      return Err(format!("the stable feed {stable} names no file"));
    }
    let of_tag = |tag: &str| {
      let mut feed = stable.clone();
      feed.set_path(&format!("{owner}/{repository}/releases/download/{tag}/{file}"));
      feed
    };
    let (preview, nightly) = (of_tag(PREVIEW_TAG), of_tag(NIGHTLY_TAG));
    Ok(Self {
      stable,
      preview,
      nightly,
    })
  }

  /// The feeds the updater's configuration names: its first endpoint is the stable feed.
  pub fn from_updater_config(config: &Value) -> Result<Self, String> {
    let endpoint = config
      .get("endpoints")
      .and_then(|endpoints| endpoints.get(0))
      .and_then(Value::as_str)
      .ok_or("the updater's configuration names no endpoint")?;
    let stable = Url::parse(endpoint)
      .map_err(|error| format!("the updater endpoint {endpoint} is not a URL: {error}"))?;
    Self::beside(stable)
  }

  /// The feed a channel's updates are read from.
  pub fn of(&self, channel: Channel) -> &Url {
    match channel {
      Channel::Stable => &self.stable,
      Channel::Preview => &self.preview,
      Channel::Nightly => &self.nightly,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn each_pre_release_channels_feed_is_its_pre_releases_copy_of_the_stable_one() {
    let feeds = Feeds::from_updater_config(&serde_json::json!({
      "endpoints": ["https://github.com/owner/app/releases/latest/download/latest.json"]
    }))
    .unwrap();

    assert_eq!(
      feeds.of(Channel::Stable).as_str(),
      "https://github.com/owner/app/releases/latest/download/latest.json"
    );
    assert_eq!(
      feeds.of(Channel::Preview).as_str(),
      "https://github.com/owner/app/releases/download/desktop-preview/latest.json"
    );
    assert_eq!(
      feeds.of(Channel::Nightly).as_str(),
      "https://github.com/owner/app/releases/download/desktop-nightly/latest.json"
    );
  }

  #[test]
  fn an_update_servers_feeds_name_their_channels() {
    let stable = "https://updates.example/bmo-update/updates/bmo-desktop/stable/{{target}}/{{arch}}/{{current_version}}?bundleType={{bundle_type}}";
    let feeds = Feeds::beside(Url::parse(stable).unwrap()).unwrap();

    assert_eq!(
      feeds.of(Channel::Nightly).as_str(),
      "https://updates.example/bmo-update/updates/bmo-desktop/nightly/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D?bundleType={{bundle_type}}"
    );
    assert_eq!(
      feeds.of(Channel::Preview).as_str(),
      "https://updates.example/bmo-update/updates/bmo-desktop/preview/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D?bundleType={{bundle_type}}"
    );
    assert_eq!(feeds.of(Channel::Stable), &Url::parse(stable).unwrap());
  }

  #[test]
  fn a_stable_feed_that_is_no_latest_releases_asset_names_no_feeds() {
    for endpoint in [
      "https://updates.example/updates/bmo-desktop/nightly/{{target}}/{{arch}}/{{current_version}}",
      "https://updates.example/updates/bmo-desktop/preview/{{target}}/{{arch}}/{{current_version}}",
      "https://updates.example/updates/bmo-desktop/stable/{{target}}/{{arch}}",
      "https://ai.example/bmo/desktop/latest.json",
      "https://github.com/owner/app/releases/download/desktop-v1.0.0/latest.json",
      "https://github.com/owner/app/releases/latest/download/",
    ] {
      assert!(Feeds::beside(Url::parse(endpoint).unwrap()).is_err(), "{endpoint}");
    }
  }

  #[test]
  fn a_configuration_with_no_endpoint_names_no_feeds() {
    for config in [
      serde_json::json!({}),
      serde_json::json!({ "endpoints": [] }),
      serde_json::json!({ "endpoints": [7] }),
    ] {
      assert!(Feeds::from_updater_config(&config).is_err(), "{config}");
    }
    assert!(Feeds::from_updater_config(&serde_json::json!({ "endpoints": ["not a url"] })).is_err());
  }

  #[test]
  fn the_project_configuration_names_every_feed() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let feeds = Feeds::from_updater_config(&config["plugins"]["updater"]).unwrap();

    assert_eq!(
      feeds.of(Channel::Stable).as_str(),
      "https://github.com/ahas/jake/releases/latest/download/latest.json"
    );
    assert_eq!(
      feeds.of(Channel::Preview).as_str(),
      "https://github.com/ahas/jake/releases/download/desktop-preview/latest.json"
    );
    assert_eq!(
      feeds.of(Channel::Nightly).as_str(),
      "https://github.com/ahas/jake/releases/download/desktop-nightly/latest.json"
    );
  }

  #[test]
  fn a_channel_is_read_by_its_name_alone() {
    let read = |value: Value| serde_json::from_value::<Channel>(value);

    assert_eq!(read(Value::from("stable")).unwrap(), Channel::Stable);
    assert_eq!(read(Value::from("preview")).unwrap(), Channel::Preview);
    assert_eq!(read(Value::from("nightly")).unwrap(), Channel::Nightly);
    for refused in [
      Value::from("Stable"),
      Value::from("beta"),
      Value::from("Preview"),
      Value::from(""),
      Value::from(true),
      Value::Null,
    ] {
      assert!(read(refused.clone()).is_err(), "{refused}");
    }
    assert_eq!(Channel::default(), Channel::Stable);
  }
}
