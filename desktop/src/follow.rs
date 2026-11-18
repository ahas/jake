// A watch that follows two others through a rule.

use tokio::sync::watch;

/// Keep `out` at what `rule` makes of `a` and `b`, sending only a change, until either's sender is gone.
pub async fn follow<A, B>(
  mut a: watch::Receiver<A>,
  mut b: watch::Receiver<B>,
  rule: impl Fn(&A, &B) -> bool,
  out: watch::Sender<bool>,
) {
  loop {
    let now = rule(&a.borrow_and_update(), &b.borrow_and_update());
    out.send_if_modified(|held| std::mem::replace(held, now) != now);
    tokio::select! {
      changed = a.changed() => if changed.is_err() { return },
      changed = b.changed() => if changed.is_err() { return },
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn the_output_follows_either_input_and_ends_with_them() {
    let (a, a_seen) = watch::channel(false);
    let (b, b_seen) = watch::channel(false);
    let (out, mut seen) = watch::channel(false);
    let following = tokio::spawn(follow(a_seen, b_seen, |a: &bool, b: &bool| *a && !*b, out));

    a.send_replace(true);
    seen.wait_for(|on| *on).await.unwrap();
    b.send_replace(true);
    seen.wait_for(|on| !*on).await.unwrap();
    drop(a);
    following.await.unwrap();
    assert!(seen.changed().await.is_err());
  }
}
