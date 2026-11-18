// Starting at sign-in: the person's own registration, kept in line with the setting, and starting in the tray.

use std::path::Path;

use auto_launch::{AutoLaunch, AutoLaunchBuilder, WindowsEnableMode};

use crate::settings::{Switch, Switches};

/// The argument the sign-in registration starts the app with.
pub const AT_SIGN_IN: &str = "--at-sign-in";

/// The person's own sign-in registration of the running executable, never the machine's, whether or
/// not the app runs elevated.
pub struct Registration(AutoLaunch);

impl Registration {
  /// The registration under `name`, starting the running executable with the sign-in argument.
  pub fn new(name: &str) -> Result<Self, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let program = program(&exe, cfg!(windows), std::env::var("APPIMAGE").ok());
    AutoLaunchBuilder::new()
      .set_app_name(name)
      .set_app_path(&program)
      .set_args(&[AT_SIGN_IN])
      .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
      .build()
      .map(Self)
      .map_err(|error| error.to_string())
  }

  /// Register, or take the registration away.
  pub fn set(&self, on: bool) -> Result<(), String> {
    let done = if on { self.0.enable() } else { self.0.disable() };
    done.map_err(|error| error.to_string())
  }

  /// Whether a registration stands.
  pub fn is_set(&self) -> bool {
    self.0.is_enabled().unwrap_or(false)
  }
}

/// The program the registration starts: on Windows the executable quoted, since the entry is one
/// command line and a path may hold a space; elsewhere the AppImage the app runs from, where it runs
/// from one, or the executable.
fn program(exe: &Path, windows: bool, appimage: Option<String>) -> String {
  if windows {
    format!("\"{}\"", exe.display())
  } else {
    appimage.unwrap_or_else(|| exe.display().to_string())
  }
}

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
  fn the_registered_program_is_quoted_on_windows_and_is_the_appimage_where_one_runs() {
    let exe = Path::new(r"C:\Users\Some One\AppData\Local\BMO\jake-desktop.exe");
    assert_eq!(program(exe, true, None), r#""C:\Users\Some One\AppData\Local\BMO\jake-desktop.exe""#);
    let exe = Path::new("/tmp/.mount_BMO/usr/bin/jake-desktop");
    assert_eq!(
      program(exe, false, Some("/home/tester/BMO.AppImage".into())),
      "/home/tester/BMO.AppImage"
    );
    assert_eq!(program(exe, false, None), "/tmp/.mount_BMO/usr/bin/jake-desktop");
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
