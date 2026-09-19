//! Debug helper: dump the newest console entries from a data dir.
//! `cargo run -p plinth-core --example console_dump -- ~/.local/share/dev.plinth.app`
use plinth_core::store::Store;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir = std::env::args().nth(1).expect("data dir");
    let store = Store::open(std::path::Path::new(&dir)).await?;
    let entries = store.console_list(None, 5).await?;
    println!("{}", serde_json::to_string_pretty(&entries)?);
    Ok(())
}
