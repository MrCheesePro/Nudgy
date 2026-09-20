pub mod calendar;
pub mod canvas;
pub mod travel;

use anyhow::Result;
use async_trait::async_trait;

use crate::models::LmsTask;

/// Any learning management system Nudgy can pull deadlines from. Canvas is the first
/// implementation; the trait exists so the sync command, the storage layer and the UI
/// never learn Canvas's particular shape.
#[async_trait]
pub trait LmsProvider: Send + Sync {
    /// Stable identifier stored on every task row.
    fn provider_id(&self) -> &'static str;

    /// Upcoming, incomplete work. Implementations are responsible for their own
    /// pagination, rate-limit handling and payload sanitation.
    async fn fetch_tasks(&self) -> Result<Vec<LmsTask>>;
}
