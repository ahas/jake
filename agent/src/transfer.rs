// Moving a file across the tunnel: an upload written to a temp file and moved into place once it
// verifies, and a download streamed off the disk with its size and checksum declared up front.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use jake_protocol::{Checksum, Direction, EncodedBytes, Frame, TRANSFER_CHUNK_BYTES, decode_bytes};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::log::Log;

/// The transfer error code a file-system failure is reported under.
pub fn fs_error_code(kind: ErrorKind) -> &'static str {
  match kind {
    ErrorKind::NotFound => "not-found",
    ErrorKind::PermissionDenied => "permission",
    ErrorKind::StorageFull => "disk-full",
    ErrorKind::IsADirectory => "is-directory",
    _ => "fs-error",
  }
}

struct Failure {
  code: &'static str,
  message: String,
}

impl Failure {
  fn io(path: &Path, error: &std::io::Error) -> Self {
    Self {
      code: fs_error_code(error.kind()),
      message: format!("{}: {error}", path.display()),
    }
  }
}

// An upload being assembled at a temporary path beside its target.
struct Upload {
  path: PathBuf,
  temp: PathBuf,
  file: File,
  sum: Checksum,
  received: u64,
  expected_seq: u64,
}

/// Every transfer open on one connection. The connection feeds it the transfer frames in order.
pub struct Transfers {
  out: mpsc::Sender<Frame>,
  max_payload_bytes: usize,
  log: Log,
  uploads: HashMap<String, Upload>,
  downloads: HashMap<String, JoinHandle<()>>,
}

/// A temporary name beside the target, unique to this transfer, that a reader never takes for a file.
fn temp_beside(path: &Path, id: &str) -> PathBuf {
  let tag: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
  let tag = if tag.is_empty() { "x".to_owned() } else { tag };
  let nonce: u64 = rand::random();
  path.with_file_name(format!(".jake-{tag}-{nonce:016x}.part"))
}

impl Transfers {
  pub fn new(out: mpsc::Sender<Frame>, max_payload_bytes: usize, log: Log) -> Self {
    Self {
      out,
      max_payload_bytes,
      log,
      uploads: HashMap::new(),
      downloads: HashMap::new(),
    }
  }

  async fn fail(&self, id: &str, failure: Failure) {
    let frame = Frame::Error {
      id: id.to_owned(),
      code: failure.code.into(),
      message: failure.message,
    };
    let _ = self.out.send(frame).await;
  }

  pub async fn begin(&mut self, id: String, direction: Direction, path: String) {
    self.downloads.retain(|_, task| !task.is_finished());
    if self.uploads.contains_key(&id) || self.downloads.contains_key(&id) {
      let message = "a transfer with this id is already in progress".to_owned();
      return self
        .fail(
          &id,
          Failure {
            code: "duplicate",
            message,
          },
        )
        .await;
    }
    let path = PathBuf::from(path);
    match direction {
      Direction::Upload => {
        let temp = temp_beside(&path, &id);
        match File::create(&temp).await {
          Ok(file) => {
            let upload = Upload {
              path,
              temp,
              file,
              sum: Checksum::default(),
              received: 0,
              expected_seq: 0,
            };
            self.uploads.insert(id, upload);
          }
          Err(error) => self.fail(&id, Failure::io(&temp, &error)).await,
        }
      }
      Direction::Download => {
        let task = tokio::spawn(download(id.clone(), path, self.out.clone()));
        self.downloads.insert(id, task);
      }
    }
  }

  pub async fn chunk(&mut self, id: &str, seq: u64, chunk: &EncodedBytes) {
    let Some(upload) = self.uploads.get_mut(id) else { return };
    let outcome = if seq == upload.expected_seq {
      match decode_bytes(chunk, self.max_payload_bytes) {
        Ok(data) => {
          upload.expected_seq += 1;
          upload.sum.update(&data);
          upload.received += data.len() as u64;
          upload.file.write_all(&data).await.map_err(|error| Failure::io(&upload.temp, &error))
        }
        Err(error) => Err(Failure {
          code: "bad-chunk",
          message: error.message,
        }),
      }
    } else {
      Err(Failure {
        code: "out-of-order",
        message: format!("expected chunk {}, got {seq}", upload.expected_seq),
      })
    };
    if let Err(failure) = outcome {
      self.discard(id).await;
      self.fail(id, failure).await;
    }
  }

  pub async fn end(&mut self, id: &str, total: u64, checksum: &str) {
    let Some(mut upload) = self.uploads.remove(id) else { return };
    if let Err(error) = upload.file.flush().await {
      let _ = fs::remove_file(&upload.temp).await;
      return self.fail(id, Failure::io(&upload.temp, &error)).await;
    }
    drop(upload.file);
    if upload.received != total || upload.sum.finish() != checksum {
      let _ = fs::remove_file(&upload.temp).await;
      let message = format!("assembled {} bytes did not match the declared transfer", upload.received);
      return self
        .fail(
          id,
          Failure {
            code: "integrity",
            message,
          },
        )
        .await;
    }
    if let Err(error) = fs::rename(&upload.temp, &upload.path).await {
      let _ = fs::remove_file(&upload.temp).await;
      return self.fail(id, Failure::io(&upload.path, &error)).await;
    }
    let frame = Frame::TransferEnd {
      id: id.to_owned(),
      total,
      checksum: checksum.to_owned(),
    };
    let _ = self.out.send(frame).await;
  }

  /// Stop one transfer without answering for it: the hub has given it up.
  pub async fn discard(&mut self, id: &str) {
    if let Some(upload) = self.uploads.remove(id) {
      drop(upload.file);
      if let Err(error) = fs::remove_file(&upload.temp).await {
        self
          .log
          .warn("transfer-cleanup-failed", serde_json::json!({ "id": id, "error": error.to_string() }));
      }
    }
    if let Some(task) = self.downloads.remove(id) {
      task.abort();
    }
  }

  /// Drop every open transfer, the socket it belonged to being gone, so no temp file is left behind.
  pub async fn abandon(&mut self) {
    let ids: Vec<String> = self.uploads.keys().chain(self.downloads.keys()).cloned().collect();
    for id in ids {
      self.discard(&id).await;
    }
  }
}

// A file read piece by piece, each piece as large as a transfer chunk until the last.
struct Pieces {
  file: File,
  buffer: Vec<u8>,
}

impl Pieces {
  async fn open(path: &Path) -> std::io::Result<Self> {
    Ok(Self {
      file: File::open(path).await?,
      buffer: vec![0; TRANSFER_CHUNK_BYTES],
    })
  }

  /// The next piece, or none at the end of the file.
  async fn next(&mut self) -> std::io::Result<Option<&[u8]>> {
    let mut filled = 0;
    while filled < self.buffer.len() {
      match self.file.read(&mut self.buffer[filled..]).await? {
        0 => break,
        n => filled += n,
      }
    }
    Ok((filled > 0).then(|| &self.buffer[..filled]))
  }
}

async fn hash_file(path: &Path) -> std::io::Result<String> {
  let mut pieces = Pieces::open(path).await?;
  let mut sum = Checksum::default();
  while let Some(piece) = pieces.next().await? {
    sum.update(piece);
  }
  Ok(sum.finish())
}

// Every piece of the file as a chunk frame; false once the connection has stopped taking them.
async fn stream_file(id: &str, path: &Path, out: &mpsc::Sender<Frame>) -> std::io::Result<bool> {
  let mut pieces = Pieces::open(path).await?;
  let mut seq = 0;
  while let Some(piece) = pieces.next().await? {
    let chunk = Frame::TransferChunk {
      id: id.to_owned(),
      seq,
      chunk: EncodedBytes::of(piece),
    };
    seq += 1;
    if out.send(chunk).await.is_err() {
      return Ok(false);
    }
  }
  Ok(true)
}

// The first pass hashes the file, so the answering begin carries the checksum the receiver verifies;
// a file that changes between the passes is caught by that same check.
async fn download(id: String, path: PathBuf, out: mpsc::Sender<Frame>) {
  let fail = |failure: Failure| Frame::Error {
    id: id.clone(),
    code: failure.code.into(),
    message: failure.message,
  };
  let total = match fs::metadata(&path).await {
    Ok(meta) if meta.is_dir() => {
      let message = format!("{} is a directory", path.display());
      let _ = out
        .send(fail(Failure {
          code: "is-directory",
          message,
        }))
        .await;
      return;
    }
    Ok(meta) => meta.len(),
    Err(error) => {
      let _ = out.send(fail(Failure::io(&path, &error))).await;
      return;
    }
  };
  let checksum = match hash_file(&path).await {
    Ok(checksum) => checksum,
    Err(error) => {
      let _ = out.send(fail(Failure::io(&path, &error))).await;
      return;
    }
  };
  let begin = Frame::TransferBegin {
    id: id.clone(),
    direction: Direction::Download,
    path: path.display().to_string(),
    total: Some(total),
    checksum: Some(checksum.clone()),
  };
  if out.send(begin).await.is_err() {
    return;
  }
  let last = match stream_file(&id, &path, &out).await {
    Ok(false) => return,
    Ok(true) => Frame::TransferEnd {
      id: id.clone(),
      total,
      checksum,
    },
    Err(error) => fail(Failure::io(&path, &error)),
  };
  let _ = out.send(last).await;
}
