// Where the first run's commands and the set run (docs/all-in-one.md, 「Windows through WSL 2」): this machine,
// or the BMO distribution of WSL 2 on Windows, each command's words wrapped for it and its output read line by
// line as it comes.

use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Where a command runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Host {
  /// This machine, as the account the app runs as.
  Local,
  /// The WSL 2 distribution `distro`, as `account`.
  Wsl { distro: String, account: String },
}

/// Who a command runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum As {
  Account,
  /// Root: on this machine through the system's own prompt, `pkexec`, never through the app.
  Root,
}

impl Host {
  /// The words that run `words` here as `who`, with `env` laid over the environment.
  pub fn line(&self, words: &[String], env: &[(String, String)], who: As) -> Vec<String> {
    let overlay: Vec<String> = env.iter().map(|(key, value)| format!("{key}={value}")).collect();
    let with_env = |mut line: Vec<String>| {
      if !overlay.is_empty() {
        line.push("env".to_owned());
        line.extend(overlay.iter().cloned());
      }
      line.extend(words.iter().cloned());
      line
    };
    match self {
      Host::Local => match who {
        As::Account => with_env(Vec::new()),
        As::Root => with_env(vec!["pkexec".to_owned()]),
      },
      Host::Wsl { distro, account } => {
        let user = match who {
          As::Account => account.clone(),
          As::Root => "root".to_owned(),
        };
        with_env(["wsl.exe", "-d", distro, "-u", &user, "--exec"].map(str::to_owned).to_vec())
      }
    }
  }

  /// The words that run a script of the app's own with `sh`, the script handed on standard input.
  pub fn script(&self, args: &[String], env: &[(String, String)], who: As) -> Vec<String> {
    let words: Vec<String> =
      ["sh", "-s", "--"].into_iter().map(str::to_owned).chain(args.iter().cloned()).collect();
    self.line(&words, env, who)
  }
}

/// How a command ended: its code, its standard output whole, and its last lines of either stream for a person to
/// read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
  pub code: i32,
  pub out: String,
  pub tail: String,
}

/// How many of a command's last lines are kept to show.
const TAIL_LINES: usize = 20;

/// Runs `line`, handing it `stdin` and each line it writes to `each`, standard output and standard error alike;
/// a program that cannot start ends with 127 and the reason.
pub async fn run(line: &[String], stdin: Option<String>, mut each: impl FnMut(&str) + Send) -> Ended {
  let Some((program, args)) = line.split_first() else {
    return Ended {
      code: 127,
      out: String::new(),
      tail: "no command".to_owned(),
    };
  };
  let mut command = tokio::process::Command::new(program);
  command
    .args(args)
    .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(windows)]
  command.creation_flags(0x0800_0000);
  let mut child = match command.spawn() {
    Ok(child) => child,
    Err(error) => {
      return Ended {
        code: 127,
        out: String::new(),
        tail: format!("{program}: {error}"),
      };
    }
  };
  if let (Some(text), Some(mut input)) = (stdin, child.stdin.take()) {
    let _ = input.write_all(text.as_bytes()).await;
    drop(input);
  }
  let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else {
    return Ended {
      code: 127,
      out: String::new(),
      tail: "no output".to_owned(),
    };
  };
  let mut out = BufReader::new(out).lines();
  let mut err = BufReader::new(err).lines();
  let mut tail: Vec<String> = Vec::new();
  let mut whole = String::new();
  let mut keep = |line: String, each: &mut dyn FnMut(&str)| {
    each(&line);
    tail.push(line);
    if tail.len() > TAIL_LINES {
      tail.remove(0);
    }
  };
  let (mut out_open, mut err_open) = (true, true);
  while out_open || err_open {
    tokio::select! {
      line = out.next_line(), if out_open => match line {
        Ok(Some(line)) => {
          whole.push_str(&line);
          whole.push('\n');
          keep(line, &mut each);
        }
        _ => out_open = false,
      },
      line = err.next_line(), if err_open => match line {
        Ok(Some(line)) => keep(line, &mut each),
        _ => err_open = false,
      },
    }
  }
  let code = child.wait().await.ok().and_then(|status| status.code()).unwrap_or(1);
  Ended {
    code,
    out: whole,
    tail: tail.join("\n"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn words(text: &[&str]) -> Vec<String> {
    text.iter().map(|word| (*word).to_owned()).collect()
  }

  #[test]
  fn a_command_runs_here_as_given_and_as_root_through_the_systems_prompt() {
    let env = vec![("BMO_SUPERVISOR".to_owned(), "/s.sock".to_owned())];
    assert_eq!(Host::Local.line(&words(&["git", "pull"]), &[], As::Account), words(&["git", "pull"]));
    assert_eq!(
      Host::Local.line(&words(&["install"]), &env, As::Root),
      words(&["pkexec", "env", "BMO_SUPERVISOR=/s.sock", "install"])
    );
  }

  #[test]
  fn a_command_in_the_distribution_runs_through_wsl_as_its_account() {
    let host = Host::Wsl {
      distro: "BMO".into(),
      account: "someone".into(),
    };
    assert_eq!(
      host.script(&words(&["/home/someone/bmo"]), &[], As::Account),
      words(&["wsl.exe", "-d", "BMO", "-u", "someone", "--exec", "sh", "-s", "--", "/home/someone/bmo"])
    );
    assert_eq!(host.line(&words(&["service", "postgresql", "start"]), &[], As::Root)[4], "root");
  }

  #[tokio::test]
  async fn a_run_hands_on_its_input_and_reads_every_line() {
    let mut seen = Vec::new();
    let ended = run(&words(&["sh", "-s"]), Some("echo one; echo two >&2; exit 3\n".into()), |line| {
      seen.push(line.to_owned())
    })
    .await;
    assert_eq!(ended.code, 3);
    assert_eq!(ended.out, "one\n");
    seen.sort();
    assert_eq!(seen, ["one", "two"]);
    assert_eq!(run(&words(&["/no/such/program"]), None, |_| {}).await.code, 127);
  }
}
