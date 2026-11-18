// Starting at sign-in: keeping the system's registration in line with the setting, and starting in the tray.

use crate::settings::{Switch, Switches};

/// The argument the sign-in registration starts the app with.
pub const AT_SIGN_IN: &str = "--at-sign-in";

/// What bringing the registration into line with the setting asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Alignment {
  /// The file states nothing, so the registration as it stands becomes the setting.
  Adopt(bool),
  /// Register again, putting back a registration a reset wiped and naming the running executable.
  Register,
  /// Take a registration the setting does not want away.
  Unregister,
  /// The registration already agrees.
  Keep,
}

/// What the stated setting and the registration found ask for.
pub fn align(stated: Option<bool>, registered: bool) -> Alignment {
  match (stated, registered) {
    (None, registered) => Alignment::Adopt(registered),
    (Some(true), _) => Alignment::Register,
    (Some(false), true) => Alignment::Unregister,
    (Some(false), false) => Alignment::Keep,
  }
}

/// Whether the app opens its window as it starts: always when started by hand, and when started at
/// sign-in unless the settings say to start in the tray.
pub fn opens_window(mut args: impl Iterator<Item = String>, switches: &Switches) -> bool {
  !(args.any(|arg| arg == AT_SIGN_IN) && switches.on(Switch::StartInTray))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_registration_follows_the_setting_and_an_unstated_setting_follows_the_registration() {
    assert_eq!(align(None, true), Alignment::Adopt(true));
    assert_eq!(align(None, false), Alignment::Adopt(false));
    assert_eq!(align(Some(true), true), Alignment::Register);
    assert_eq!(align(Some(true), false), Alignment::Register);
    assert_eq!(align(Some(false), true), Alignment::Unregister);
    assert_eq!(align(Some(false), false), Alignment::Keep);
  }

  #[test]
  fn only_a_start_at_sign_in_with_the_tray_setting_on_opens_no_window() {
    let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>().into_iter();
    let tray = Switches::default().with(Switch::StartInTray, true);
    assert!(!opens_window(args(&["bmo", AT_SIGN_IN]), &tray));
    assert!(opens_window(args(&["bmo"]), &tray));
    assert!(opens_window(args(&["bmo", AT_SIGN_IN]), &Switches::default()));
  }
}
