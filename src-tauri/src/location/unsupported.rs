//! Platforms with no native location service. Not an error state: the caller falls back
//! to the provider's network lookup, which needs no permission at all.

use anyhow::{anyhow, Result};

use super::Coordinates;

pub fn current() -> Result<Coordinates> {
    Err(anyhow!("this platform has no native location service"))
}
