// Credentials made with a key of the hub's, and the agents a control caller may reach.

use std::collections::BTreeSet;

use hmac::{Hmac, Mac};

/// The credential of a subject: the subject, a dot, and the lowercase hex of HMAC-SHA256 over the
/// subject keyed by `key`.
pub fn credential(key: &str, subject: &str) -> String {
  let mut mac =
    Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes()).expect("HMAC takes a key of any length");
  mac.update(subject.as_bytes());
  let hex: String = mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
  format!("{subject}.{hex}")
}

/// The subject a presented credential was made for with `key`; none where it was not made with it.
pub fn subject<'a>(key: &str, presented: &'a str) -> Option<&'a str> {
  let (subject, _) = presented.rsplit_once('.')?;
  (!subject.is_empty() && credential(key, subject) == presented).then_some(subject)
}

/// The agents a control caller may reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reach {
  /// Every agent: the control token's reach.
  All,
  /// The named agents alone: a scoped credential's reach.
  Agents(BTreeSet<String>),
}

impl Reach {
  /// The reach of a scoped credential's subject, its agent names joined by commas; none where it
  /// names no agent.
  pub fn of_names(subject: &str) -> Option<Self> {
    let names: BTreeSet<String> = subject
      .split(',')
      .map(str::trim)
      .filter(|name| !name.is_empty())
      .map(str::to_owned)
      .collect();
    (!names.is_empty()).then_some(Self::Agents(names))
  }

  /// True when the caller may reach the named agent.
  pub fn admits(&self, name: &str) -> bool {
    match self {
      Self::All => true,
      Self::Agents(names) => names.contains(name),
    }
  }

  /// True when the caller may see a record tagged with this agent, or with none.
  pub fn shows(&self, agent: Option<&str>) -> bool {
    match agent {
      Some(name) => self.admits(name),
      None => *self == Self::All,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_credential_names_its_subject_only_under_its_own_key() {
    let made = credential("k", "u4,u7");
    assert_eq!(subject("k", &made), Some("u4,u7"));
    assert_eq!(subject("other", &made), None);
    assert_eq!(subject("k", "u4,u7.00"), None);
    assert_eq!(subject("k", "no-mac"), None);
  }

  #[test]
  fn a_scoped_reach_admits_its_names_and_shows_no_untagged_record() {
    let reach = Reach::of_names("u4, u7,").expect("names two agents");
    assert!(reach.admits("u4") && reach.admits("u7") && !reach.admits("u5"));
    assert!(reach.shows(Some("u4")) && !reach.shows(Some("u5")) && !reach.shows(None));
    assert!(Reach::All.shows(None));
    assert_eq!(Reach::of_names(" , "), None);
  }
}
