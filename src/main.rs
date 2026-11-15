use roundhouse::{config::Config, engine::Runtime};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        // run() returns host-owned diagnostics, never raw provider or HTTP errors.
        eprintln!("Roundhouse stopped: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "roundhouse.json".into());
    let config = Config::load(&path)?;
    let listener = tokio::net::TcpListener::bind(&config.listen)
        .await
        .map_err(|_| "cannot bind")?;
    let rt = Runtime::new(config)?;
    println!("Roundhouse ready; durable queue and monitoring enabled");
    tokio::select! {
        result=axum::serve(listener,roundhouse::router(rt.clone())) => result.map_err(|_|"API failed".into()),
        result=roundhouse::scheduler(rt.clone()) => result,
        result=roundhouse::worker(rt) => result,
        _=shutdown() => Ok(()),
    }
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! { _=signal.recv()=>{}, _=tokio::signal::ctrl_c()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
