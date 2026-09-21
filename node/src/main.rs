//! Ringtome connector node - the operator's binary.
//!
//! Thin by design (DESKTOP.md, Stage 1): the composition root lives in the library, so that the
//! desktop shell boots the same node this binary does rather than a second assembly of it. What
//! is left here is what only a command line has - the subcommands, and the decision to read the
//! config from the environment.

use ringtome_node::{config::Config, init_tracing, inspect, run};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Subcommands run and exit before any server machinery boots.
    let mut args = std::env::args().skip(1);
    if let Some(cmd) = args.next() {
        match cmd.as_str() {
            "inspect" => {
                let target = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("usage: ringtome inspect <hex-or-file>"))?;
                return inspect::run(&target);
            }
            other => anyhow::bail!("unknown command {other:?} (try: ringtome inspect <entry>)"),
        }
    }

    let config = Config::from_env();
    init_tracing(&config);
    run(config).await
}
