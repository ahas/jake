// The channel the app's updates come from, and the feed each channel is read from.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// The nightly feed's address, relative to the stable one.
const NIGHTLY_FEED: &str = "nightly/latest.json";

/// The channel the app's updates come from (docs/desktop.md, 「The update channel」): the set's releases
/// alone, or the day's build between them as well. A file that names none runs on stable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
  #[default]
  Stable,
  Nightly,
}

/// Each channel's updater feed: the configuration's own endpoint for stable, and the nightly feed beside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feeds {
  stable: Url,
  nightly: Url,
}

impl Feeds {
  /// The feeds beside the stable one.
  pub fn beside(stable: Url) -> Result<Self, String> {
    let nightly = stable
      .join(NIGHTLY_FEED)
      .map_err(|error| format!("no nightly feed beside {stable}: {error}"))?;
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
  fn the_nightly_feed_stands_beside_the_stable_one() {
    let feeds = Feeds::from_updater_config(
      &serde_json::json!({ "endpoints": ["https://ai.example/bmo/desktop/latest.json"] }),
    )
    .unwrap();

    assert_eq!(feeds.of(Channel::Stable).as_str(), "https://ai.example/bmo/desktop/latest.json");
    assert_eq!(
      feeds.of(Channel::Nightly).as_str(),
      "https://ai.example/bmo/desktop/nightly/latest.json"
    );
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

    let stable = feeds.of(Channel::Stable).as_str();
    let folder = stable.strip_suffix("latest.json").expect("the stable feed is a latest.json");

    assert_eq!(feeds.of(Channel::Nightly).as_str(), format!("{folder}nightly/latest.json"));
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
