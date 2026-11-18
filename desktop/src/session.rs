// Whether the person's session is locked, as the system tells the app.

use jake_agent::Log;
use tokio::sync::watch;

/// Report the session's lock into `locked` for as long as the app runs; where the platform tells the
/// app nothing, the session never reads as locked.
pub fn report(locked: watch::Sender<bool>, log: Log) {
  #[cfg(windows)]
  windows::report(locked, log);
  #[cfg(not(windows))]
  let _ = (locked, log);
}

#[cfg(windows)]
mod windows {
  use std::ptr::{null, null_mut};
  use std::sync::OnceLock;

  use jake_agent::Log;
  use serde_json::json;
  use tokio::sync::watch;
  use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
  use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
  use windows_sys::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
    WTS_SESSIONSTATE_UNLOCK, WTSFreeMemory, WTSINFOEXW, WTSQuerySessionInformationW,
    WTSRegisterSessionNotification, WTSSessionInfoEx,
  };
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, HWND_MESSAGE, MSG, RegisterClassW,
    WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
  };

  /// Where the window's procedure, which carries no context of its own, sends what it hears.
  static HEARD: OnceLock<(watch::Sender<bool>, Log)> = OnceLock::new();

  pub fn report(locked: watch::Sender<bool>, log: Log) {
    let thread_log = log.clone();
    let started = std::thread::Builder::new()
      .name("session-lock".into())
      .spawn(move || listen(locked, thread_log));
    if let Err(error) = started {
      log.warn("session-lock-unread", json!({ "reason": error.to_string() }));
    }
  }

  /// Read the lock as it stands, then take each change from a message-only window registered for the
  /// session's notifications, for as long as the app runs.
  fn listen(locked: watch::Sender<bool>, log: Log) {
    if let Some(now) = locked_now() {
      locked.send_replace(now);
    }
    if HEARD.set((locked, log.clone())).is_err() {
      return;
    }
    let class: Vec<u16> = "JakeDesktopSessionLock\0".encode_utf16().collect();
    // SAFETY: every pointer handed over lives for the call, the class name for the thread's life, and
    // the window and its messages stay on this thread.
    unsafe {
      let instance = GetModuleHandleW(null());
      let window_class = WNDCLASSW {
        lpfnWndProc: Some(procedure),
        hInstance: instance,
        lpszClassName: class.as_ptr(),
        ..Default::default()
      };
      RegisterClassW(&window_class);
      let window = CreateWindowExW(
        0,
        class.as_ptr(),
        null(),
        0,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        null_mut(),
        instance,
        null(),
      );
      if window.is_null() {
        log.warn("session-lock-unread", json!({ "reason": "no message window" }));
        return;
      }
      if WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) == 0 {
        log.warn("session-lock-unread", json!({ "reason": "session notifications refused" }));
        return;
      }
      let mut message = MSG::default();
      while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
        DispatchMessageW(&message);
      }
    }
  }

  unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
  ) -> LRESULT {
    if message == WM_WTSSESSION_CHANGE {
      let now = match wparam as u32 {
        WTS_SESSION_LOCK => Some(true),
        WTS_SESSION_UNLOCK => Some(false),
        _ => None,
      };
      if let (Some(now), Some((locked, log))) = (now, HEARD.get()) {
        log.info(if now { "session-locked" } else { "session-unlocked" }, json!({}));
        locked.send_replace(now);
      }
      return 0;
    }
    // SAFETY: the message is handed on as it came.
    unsafe { DefWindowProcW(window, message, wparam, lparam) }
  }

  /// Whether this session is locked now, where the system says.
  fn locked_now() -> Option<bool> {
    let mut buffer = null_mut();
    let mut length = 0u32;
    // SAFETY: the system writes a buffer of its own, read here as the structure the class names and
    // freed with the call that frees it.
    unsafe {
      if WTSQuerySessionInformationW(
        WTS_CURRENT_SERVER_HANDLE,
        WTS_CURRENT_SESSION,
        WTSSessionInfoEx,
        &mut buffer,
        &mut length,
      ) == 0
      {
        return None;
      }
      let info = &*(buffer as *const WTSINFOEXW);
      let flags = (info.Level == 1).then_some(info.Data.WTSInfoExLevel1.SessionFlags as u32);
      WTSFreeMemory(buffer.cast());
      match flags? {
        WTS_SESSIONSTATE_LOCK => Some(true),
        WTS_SESSIONSTATE_UNLOCK => Some(false),
        _ => None,
      }
    }
  }
}
