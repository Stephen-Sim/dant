use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

pub(crate) struct Server {
    pub(crate) address: SocketAddr,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<Vec<u8>>>,
}
impl Server {
    pub(crate) fn new(response: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        assert_ne!(
            address.port(),
            crate::protocol::controller_endpoint().port()
        );
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(10);
            while !stopped.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut peer, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                peer.set_nonblocking(false).unwrap();
                peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                peer.set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 4096];
                while request.len() < 16 * 1024 {
                    match peer.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => request.extend_from_slice(&buffer[..count]),
                    }
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = std::str::from_utf8(&request[..end]).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        assert!(length <= 16 * 1024 - end - 4);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let _ = peer.write_all(&response);
                let _ = peer.shutdown(std::net::Shutdown::Write);
                let _ = peer.read(&mut buffer);
                return request;
            }
            Vec::new()
        });
        Self {
            address,
            stop,
            worker: Some(worker),
        }
    }
    pub(crate) fn request(mut self) -> Vec<u8> {
        self.stop.store(true, Ordering::Release);
        self.worker.take().unwrap().join().unwrap()
    }
    pub(crate) fn completed_request(self) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.worker.as_ref().unwrap().is_finished() {
            assert!(
                Instant::now() < deadline,
                "An expected isolated request must finish"
            );
            thread::sleep(Duration::from_millis(2));
        }
        self.request()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
