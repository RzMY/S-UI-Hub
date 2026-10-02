use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::TcpStream,
};
use tokio_util::sync::{CancellationToken, WaitForCancellationFutureOwned};

// russh owns its I/O task after connect_stream starts. Dropping its connection
// future or Handle does not abort that task during key exchange. Keep a separate
// cancellation path to the actual socket, including while reads/writes are pending.
pub(crate) struct SshTransport {
    socket: TcpStream,
    cancelled: Pin<Box<WaitForCancellationFutureOwned>>,
    stopped: bool,
}

impl SshTransport {
    pub fn new(socket: TcpStream, cancel: CancellationToken) -> Self {
        Self {
            socket,
            cancelled: Box::pin(cancel.cancelled_owned()),
            stopped: false,
        }
    }

    fn is_cancelled(&mut self, cx: &mut Context<'_>) -> bool {
        // A completed async cancellation future must never be polled again.
        self.stopped = self.stopped || self.cancelled.as_mut().poll(cx).is_ready();
        self.stopped
    }
}

fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionAborted, "SSH connection cancelled")
}

impl AsyncRead for SshTransport {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.is_cancelled(cx) {
            return Poll::Ready(Err(cancelled()));
        }
        Pin::new(&mut self.socket).poll_read(cx, buf)
    }
}

impl AsyncWrite for SshTransport {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.is_cancelled(cx) {
            return Poll::Ready(Err(cancelled()));
        }
        Pin::new(&mut self.socket).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.is_cancelled(cx) {
            return Poll::Ready(Err(cancelled()));
        }
        Pin::new(&mut self.socket).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.is_cancelled(cx) {
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn cancellation_wakes_pending_io_and_remains_safe_for_shutdown() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (_peer, _) = listener.accept().await.unwrap();
        let cancel = CancellationToken::new();
        let mut transport = SshTransport::new(socket, cancel.clone());
        let mut byte = [0];
        let mut read = Box::pin(transport.read(&mut byte));
        std::future::poll_fn(|cx| {
            assert!(read.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        cancel.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), read)
            .await
            .unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        assert!(transport.read(&mut byte).await.is_err());
        assert!(transport.write_all(b"cancelled").await.is_err());
        assert!(transport.flush().await.is_err());
        transport.shutdown().await.unwrap();
    }
}
