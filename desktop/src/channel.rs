// The channel the app's updates come from, and the feed each channel is read from.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// The tag of the one pre-release whose assets each nightly replaces (docs/desktop.md, 「Releases」).
const NIGHTLY_TAG: &str = "desktop-nightly";

/// The channel the app's updates come from (docs/desktop.md, 「The update channel」): the set's releases
/// alone, or the day's build between them as well. A file that names none runs on stable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
  #[default]
  Stable,
  Nightly,
}

/// Each channel's updater feed: the configuration's own endpoint for stable, the feed of the repository's
/// latest release, and the same file of the nightly pre-release for nightly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feeds {
  stable: Url,
  nightly: Url,
}

impl Feeds {
  /// The feeds of the repository whose latest release's asset `stable` names, as
  /// `https://github.com/<owner>/<repository>/releases/latest/download/<file>`; the nightly feed is that
  /// file of the nightly pre-release.
  pub fn beside(stable: Url) -> Result<Self, String> {
    let segments: Vec<&str> = stable.path_segments().map(Iterator::collect).unwrap_or_default();
    let [owner, repository, "releases", "latest", "download", file] = segments[..] else {
      return Err(format!("the stable feed {stable} is not a latest release's asset"));
    };
    if file.is_empty() {
      return Err(format!("the stable feed {stable} names no file"));
    }
    let mut nightly = stable.clone();
    nightly.set_path(&format!("{owner}/{repository}/releases/download/{NIGHTLY_TAG}/{file}"));
    Ok(Self { stable, nightly })
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
      Channel::Nightly => &self.nightly,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_nightly_feed_is_the_nightly_pre_releases_copy_of_the_stable_one() {
    let feeds = Feeds::from_updater_config(&serde_json::json!({
      "endpoints": ["https://github.com/owner/app/releases/latest/download/latest.json"]
    }))
    .unwrap();

    assert_eq!(
      feeds.of(Channel::Stable).as_str(),
      "https://github.com/owner/app/releases/latest/download/latest.json"
    );
    assert_eq!(
      feeds.of(Channel::Nightly).as_str(),
      "https://github.com/owner/app/releases/download/desktop-nightly/latest.json"
    );
  }

  #[test]
  fn a_stable_feed_that_is_no_latest_releases_asset_names_no_feeds() {
    for endpoint in [
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
  fn the_project_configuration_names_both_feeds() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let feeds = Feeds::from_updater_config(&config["plugins"]["updater"]).unwrap();

    assert_eq!(
      feeds.of(Channel::Stable).as_str(),
      "https://github.com/ahas/jake/releases/latest/download/latest.json"
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
    assert_eq!(read(Value::from("nightly")).unwrap(), Channel::Nightly);
    for refused in [
      Value::from("Stable"),
      Value::from("beta"),
      Value::from(""),
      Value::from(true),
      Value::Null,
    ] {
      assert!(read(refused.clone()).is_err(), "{refused}");
    }
    assert_eq!(Channel::default(), Channel::Stable);
  }
}
