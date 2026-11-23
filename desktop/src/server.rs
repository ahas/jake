// The server the person names: the address they enter, read as a console's address in their own words.

use url::Url;

use crate::settings::console_url;

/// The address a person entered, as the console's base: an address with no scheme is taken as HTTPS,
/// and plain HTTP stands only on this machine. A refusal says why in the person's words.
pub fn entered(raw: &str) -> Result<Url, String> {
  let raw = raw.trim();
  if raw.is_empty() {
    return Err("BMO 서버 주소를 입력해 주세요.".to_owned());
  }
  let address = if raw.contains("://") { raw.to_owned() } else { format!("https://{raw}") };
  let parsed = Url::parse(&address)
    .ok()
    .filter(|url| url.host_str().is_some_and(|host| !host.is_empty()))
    .ok_or_else(|| "주소 형식이 올바르지 않습니다.".to_owned())?;
  if !matches!(parsed.scheme(), "https" | "http") {
    return Err("https 주소만 쓸 수 있습니다.".to_owned());
  }
  console_url(&address)
    .map_err(|_| "https 주소만 쓸 수 있습니다. http는 localhost에서만 쓸 수 있습니다.".to_owned())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_entered_address_becomes_the_consoles_base() {
    for (raw, base) in [
      ("https://bmo.example/console", "https://bmo.example/console/"),
      ("  https://bmo.example  ", "https://bmo.example/"),
      ("bmo.example/bmo", "https://bmo.example/bmo/"),
      ("http://localhost:3000", "http://localhost:3000/"),
      ("http://127.0.0.1:4000/bmo?x=1", "http://127.0.0.1:4000/bmo/"),
    ] {
      assert_eq!(entered(raw).unwrap().as_str(), base, "{raw}");
    }
  }

  #[test]
  fn an_address_that_is_none_or_not_https_is_refused_in_the_persons_words() {
    assert_eq!(entered("   ").unwrap_err(), "BMO 서버 주소를 입력해 주세요.");
    assert_eq!(entered("https://").unwrap_err(), "주소 형식이 올바르지 않습니다.");
    assert_eq!(entered("ftp://bmo.example/").unwrap_err(), "https 주소만 쓸 수 있습니다.");
    assert!(entered("http://bmo.example/").unwrap_err().contains("localhost"));
  }
}
