//! OpenAI-compatible chat client, used only by the scheduler.
//!
//! Works against OpenAI, OpenRouter, Ollama and LM Studio because it speaks the common
//! subset: `POST {base_url}/chat/completions` with a JSON response format. Nothing here
//! decides anything — it returns parsed JSON for the deterministic layer to accept or
//! reject.

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const USER_AGENT: &str = concat!("Nudgy/", env!("CARGO_PKG_VERSION"));

pub struct LlmConfig {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    temperature: f32,
    response_format: Value,
}

#[derive(Debug, Serialize)]
struct Message<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[serde(default)]
    message: Option<ChoiceMessage>,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Asks for JSON matching `schema` and returns it parsed.
///
/// Tries strict `json_schema` first, then falls back to `json_object` with the schema
/// inlined in the prompt — older Ollama and LM Studio builds reject the strict form, and
/// failing the whole feature over a response-format flag would be absurd.
pub async fn complete_json(
    config: &LlmConfig,
    system_prompt: &str,
    user_prompt: &str,
    schema: Value,
) -> Result<Value> {
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let http = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .context("building HTTP client")?;

    let strict_format = json!({
        "type": "json_schema",
        "json_schema": { "name": "agenda", "strict": true, "schema": schema.clone() }
    });

    match request(&http, config, &url, system_prompt, user_prompt, strict_format).await {
        Ok(value) => Ok(value),
        Err(error) => {
            log::warn!("strict json_schema rejected ({error}); retrying as json_object");
            let relaxed_prompt = format!(
                "{user_prompt}\n\nRespond with JSON only, matching this schema exactly:\n{}",
                serde_json::to_string(&schema)?
            );
            request(
                &http,
                config,
                &url,
                system_prompt,
                &relaxed_prompt,
                json!({ "type": "json_object" }),
            )
            .await
        }
    }
}

async fn request(
    http: &Client,
    config: &LlmConfig,
    url: &str,
    system_prompt: &str,
    user_prompt: &str,
    response_format: Value,
) -> Result<Value> {
    let body = ChatRequest {
        model: &config.model,
        messages: vec![
            Message {
                role: "system",
                content: system_prompt,
            },
            Message {
                role: "user",
                content: user_prompt,
            },
        ],
        // The scheduler wants a reproducible plan, not creative variety.
        temperature: 0.2,
        response_format,
    };

    let mut builder = http.post(url).json(&body);
    if let Some(key) = &config.api_key {
        builder = builder.bearer_auth(key);
    }

    let response = builder.send().await.context("calling the LLM endpoint")?;
    let status = response.status();

    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let hint = match status {
            StatusCode::UNAUTHORIZED => " (check the API key in Settings)",
            StatusCode::NOT_FOUND => " (check the endpoint URL and model name)",
            _ => "",
        };
        return Err(anyhow!(
            "LLM endpoint returned {}{hint}: {}",
            status.as_u16(),
            truncate(&detail, 300)
        ));
    }

    let parsed: ChatResponse = response.json().await.context("decoding LLM response")?;
    let content = parsed
        .choices
        .into_iter()
        .find_map(|choice| choice.message.and_then(|message| message.content))
        .ok_or_else(|| anyhow!("LLM returned no content"))?;

    // Some servers wrap JSON in a ```json fence despite being asked not to.
    let cleaned = strip_code_fence(&content);
    serde_json::from_str(cleaned)
        .with_context(|| format!("LLM did not return JSON: {}", truncate(cleaned, 300)))
}

fn strip_code_fence(content: &str) -> &str {
    let trimmed = content.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    rest.trim_start_matches('\n').trim_end_matches('`').trim()
}

fn truncate(value: &str, max: usize) -> &str {
    match value.char_indices().nth(max) {
        Some((index, _)) => &value[..index],
        None => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_fenced_json_block() {
        assert_eq!(strip_code_fence("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_code_fence("  {\"a\":1}  "), "{\"a\":1}");
    }

    #[test]
    fn truncate_respects_character_boundaries() {
        assert_eq!(truncate("héllo", 2), "hé");
        assert_eq!(truncate("hi", 10), "hi");
    }
}
