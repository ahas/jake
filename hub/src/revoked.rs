// The `revoked` verb: prints the agent names the running hub has revoked, one a line.

use http_body_util::BodyExt as _;
use hyper::Method;
use serde_json::Value;

use crate::control_client::ControlClient;

/// Print every revoked name the configured control credential reaches: 0 where the hub answered, 1
/// otherwise.
pub async fn run() -> u8 {
  match revoked().await {
    Ok(names) => {
      for name in names {
        println!("{name}");
      }
      0
    }
    Err(message) => {
      eprintln!("jake-hub revoked: {message}");
      1
    }
  }
}

async fn revoked() -> Result<Vec<String>, String> {
  let client = ControlClient::load()?;
  let response = client.request(Method::GET, "/status", None).await?;
  let status = response.status();
  let body = response.into_body().collect().await.map_err(|error| error.to_string())?.to_bytes();
  if !status.is_success() {
    return Err(format!("the hub refused the status ({})", status.as_u16()));
  }
  let status: Value =
    serde_json::from_slice(&body).map_err(|error| format!("the hub's status is not JSON: {error}"))?;
  Ok(
    status["revoked"]
      .as_array()
      .into_iter()
      .flatten()
      .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
      .collect(),
  )
}
