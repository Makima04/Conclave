//! Concurrent batched LLM classification with recursive-binary-split fallback.
//!
//! Both the world-book categorizer (`worldbook_parser`) and the preset module classifier
//! (`preset_parser`) run the exact same pipeline:
//! 1. chunk items into batches of `batch_size`,
//! 2. run batches concurrently (capped at `concurrency` in flight),
//! 3. on a batch error, recursively halve the batch until a single item remains,
//! 4. when a single item fails, fall back to a heuristic for that item,
//! 5. reassemble results in original order.
//!
//! This module factors that pipeline into one generic helper so each parser only has to
//! define *how to classify a batch* (`process_batch`) and *how to fall back for one item*
//! (`single_fallback`).

use crate::error::AppError;
use futures::{StreamExt, stream};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Drive concurrent batched classification with recursive-binary-split fallback.
///
/// - `items` are chunked into slices of `batch_size`; each batch's global offset (index into
///   the original slice) is passed through.
/// - `process_batch(offset, all_items, batch)` classifies one batch. It receives the full
///   item list (`all_items`, so it can look up full content by index) and an owned batch
///   (`Vec<I>` — owned so the returned future is `'static` and need not borrow the slice).
/// - On error a batch is recursively halved; when a single item fails, `single_fallback`
///   (given the item's global index and the full item list) produces its result.
/// - Results are returned in original item order.
///
/// `label` prefixes tracing log lines so failures can be attributed to the caller.
///
/// The closures must be `'static + Clone` (they are cloned into each batch's future and into
/// the recursive split). Callers capture an owned/cloned `OpenAiProvider`, a `String` model,
/// and a `&'static str` prompt — all of which are cloneable.
pub async fn run_batched<I, O, Fut>(
    items: &[I],
    batch_size: usize,
    concurrency: usize,
    process_batch: impl Fn(usize, Arc<Vec<I>>, Vec<I>) -> Fut + Send + Sync + Clone + 'static,
    single_fallback: impl Fn(usize, &[I]) -> O + Send + Sync + Clone + 'static,
    label: &'static str,
) -> Result<Vec<O>, AppError>
where
    I: Clone + Send + Sync + 'static,
    O: Send + 'static,
    Fut: Future<Output = Result<Vec<O>, AppError>> + Send + 'static,
{
    let all: Arc<Vec<I>> = Arc::new(items.to_vec());
    let batches: Vec<(usize, Vec<I>)> = all
        .chunks(batch_size)
        .enumerate()
        .map(|(i, chunk)| (i * batch_size, chunk.to_vec()))
        .collect();

    let process = Arc::new(process_batch);
    let fallback = Arc::new(single_fallback);

    let futures = batches.into_iter().map(|(offset, batch)| {
        let process = Arc::clone(&process);
        let fallback = Arc::clone(&fallback);
        let all = Arc::clone(&all);
        async move {
            split_or_fallback(process, fallback, all, offset, batch, label)
                .await
                .map(|parsed| (offset, parsed))
        }
    });

    let mut results: Vec<(usize, Vec<O>)> = Vec::new();
    let mut pending = stream::iter(futures).buffer_unordered(concurrency);
    while let Some(r) = pending.next().await {
        results.push(r?);
    }
    results.sort_by_key(|(off, _)| *off);
    Ok(results.into_iter().flat_map(|(_, o)| o).collect())
}

/// Recursive split-or-fallback for a single batch.
///
/// Takes owned `Arc`s (cloned per future / per recursive call) so the returned future is
/// `'static` and can outlive `run_batched`'s stack frame.
fn split_or_fallback<I, O, Fut, P, F>(
    process: Arc<P>,
    fallback: Arc<F>,
    all: Arc<Vec<I>>,
    offset: usize,
    batch: Vec<I>,
    label: &'static str,
) -> Pin<Box<dyn Future<Output = Result<Vec<O>, AppError>> + Send>>
where
    I: Clone + Send + Sync + 'static,
    O: Send + 'static,
    Fut: Future<Output = Result<Vec<O>, AppError>> + Send + 'static,
    P: Fn(usize, Arc<Vec<I>>, Vec<I>) -> Fut + Send + Sync + 'static,
    F: Fn(usize, &[I]) -> O + Send + Sync + 'static,
{
    Box::pin(async move {
        match (*process)(offset, Arc::clone(&all), batch.clone()).await {
            Ok(ok) => Ok(ok),
            Err(e) if batch.len() > 1 => {
                tracing::warn!(
                    offset,
                    len = batch.len(),
                    error = %e,
                    "{label} batch failed; retrying with smaller batches"
                );
                let mid = batch.len() / 2;
                let mut left = split_or_fallback(
                    Arc::clone(&process),
                    Arc::clone(&fallback),
                    Arc::clone(&all),
                    offset,
                    batch[..mid].to_vec(),
                    label,
                )
                .await?;
                let mut right = split_or_fallback(
                    Arc::clone(&process),
                    Arc::clone(&fallback),
                    Arc::clone(&all),
                    offset + mid,
                    batch[mid..].to_vec(),
                    label,
                )
                .await?;
                left.append(&mut right);
                Ok(left)
            }
            Err(e) => {
                tracing::warn!(
                    offset,
                    error = %e,
                    "{label} single item failed; using heuristic fallback"
                );
                Ok(vec![(*fallback)(offset, &all)])
            }
        }
    })
}
