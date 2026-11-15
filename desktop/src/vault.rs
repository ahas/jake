// The machine's credential in the operating system's credential store, and nowhere else.

use keyring::{Entry, Error};
use url::Url;

use crate::pairing::Machine;

/// The service every entry of the app is kept under.
const SERVICE: &str = "io.ahas.jake.desktop";

/// The machine paired with one console, kept in the store under that console's origin.
pub struct Vault {
  account: String,
}

/// The store cannot keep the credential, for the reason given; nothing is written anywhere else.
#[derive(Debug, PartialEq, Eq)]
pub struct NoStore(pub String);

impl Vault {
  pub fn for_console(console: &Url) -> Self {
    Self {
      account: console.origin().ascii_serialization(),
    }
  }

  /// The machine kept for this console, none where nothing is kept or what is kept cannot be read.
  /// Each call goes to the store and may wait on it, so it is made off the async threads.
  pub fn load(&self) -> Result<Option<Machine>, NoStore> {
    match self.entry()?.get_password() {
      Ok(kept) => Ok(serde_json::from_str(&kept).ok()),
      Err(error) => absent(error).map(|()| None),
    }
  }

  pub fn keep(&self, machine: &Machine) -> Result<(), NoStore> {
    let kept = serde_json::to_string(machine).expect("a machine serialises");
    self.entry()?.set_password(&kept).map_err(unavailable)
  }

  /// Delete what is kept for this console; a store that holds nothing for it is left as it is.
  pub fn forget(&self) -> Result<(), NoStore> {
    match self.entry()?.delete_credential() {
      Ok(()) => Ok(()),
      Err(error) => absent(error),
    }
  }

  fn entry(&self) -> Result<Entry, NoStore> {
    Entry::new(SERVICE, &self.account).map_err(unavailable)
  }
}

/// A store that holds no entry is answered as empty; every other failure is a store that cannot keep it.
fn absent(error: Error) -> Result<(), NoStore> {
  match error {
    Error::NoEntry => Ok(()),
    error => Err(unavailable(error)),
  }
}

fn unavailable(error: Error) -> NoStore {
  NoStore(error.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn an_entry_is_kept_per_console_origin() {
    let console = Url::parse("https://console.example/bmo/").unwrap();
    assert_eq!(Vault::for_console(&console).account, "https://console.example");
  }

  #[test]
  fn an_empty_store_answers_empty_and_a_missing_one_refuses() {
    assert_eq!(absent(Error::NoEntry), Ok(()));
    assert!(absent(Error::NoDefaultStore).is_err());
  }
}
