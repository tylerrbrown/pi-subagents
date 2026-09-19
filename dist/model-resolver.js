/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */
/** Shared short and canonical labels for predictions and actual sessions. */
export function describeModel(model) {
    return {
        modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
        modelId: `${model.provider}/${model.id}`,
    };
}
/** Preserve spelling separately from identity: aliases are not mismatches. */
export function describeRequestedModel(input, registry) {
    if (!input)
        return {};
    const resolved = resolveModel(input, registry);
    return {
        requestedModel: input,
        requestedModelId: typeof resolved === "string" ? undefined : describeModel(resolved).modelId,
    };
}
const SUBSCRIPTION_PROVIDERS = ["pi-sub-anthropic", "openai-codex", "xai"];
const AWS_PROVIDERS = ["amazon-bedrock", "bedrock-mantle"];
/** Normalize cosmetic version separators before fuzzy comparison. */
function normalizeModelName(value) {
    return value.toLowerCase().replace(/\./g, "-");
}
/** Find the highest-scoring match, using provider order to resolve ties. */
function findFuzzyMatch(models, query, providerOrder) {
    let bestMatch;
    let bestScore = 0;
    let bestProviderOrder = Number.POSITIVE_INFINITY;
    for (const model of models) {
        const id = normalizeModelName(model.id);
        const name = normalizeModelName(model.name);
        const full = normalizeModelName(`${model.provider}/${model.id}`);
        let score = 0;
        if (id === query || full === query) {
            score = 100;
        }
        else if (id.includes(query) || full.includes(query)) {
            score = 60 + (query.length / id.length) * 30;
        }
        else if (name.includes(query)) {
            score = 40 + (query.length / name.length) * 20;
        }
        else if (
        // A trailing date-stamp token (e.g. "20251001") is optional, so a
        // date-pinned config like "claude-haiku-4-5-20251001" still matches an
        // undated registry id like "claude-haiku-4-5".
        query
            .split(/[\s\-/]+/)
            .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || model.provider.toLowerCase().includes(part))) {
            score = 20;
        }
        const providerIndex = providerOrder.indexOf(model.provider.toLowerCase());
        if (score > bestScore || (score === bestScore && providerIndex < bestProviderOrder)) {
            bestMatch = model;
            bestScore = score;
            bestProviderOrder = providerIndex;
        }
    }
    return bestScore >= 20 ? bestMatch : undefined;
}
/**
 * Resolve a model string to a Model instance.
 *
 * Qualified requests are strict: only the named provider is considered.
 * Providerless fuzzy requests use subscription providers first, then AWS, and
 * never select a metered direct API provider implicitly.
 */
export function resolveModel(input, registry) {
    // Available models (those with auth configured)
    const all = (registry.getAvailable?.() ?? registry.getAll());
    const slashIdx = input.indexOf("/");
    const query = normalizeModelName(input);
    const groups = [];
    if (slashIdx !== -1) {
        const provider = input.slice(0, slashIdx).toLowerCase();
        groups.push({
            models: all.filter(model => model.provider.toLowerCase() === provider),
            providerOrder: [provider],
        });
    }
    else {
        groups.push({
            models: all.filter(model => SUBSCRIPTION_PROVIDERS.includes(model.provider.toLowerCase())),
            providerOrder: SUBSCRIPTION_PROVIDERS,
        });
        groups.push({
            models: all.filter(model => AWS_PROVIDERS.includes(model.provider.toLowerCase())),
            providerOrder: AWS_PROVIDERS,
        });
    }
    for (const group of groups) {
        const match = findFuzzyMatch(group.models, query, group.providerOrder);
        if (!match)
            continue;
        const found = registry.find(match.provider, match.id);
        if (found)
            return found;
    }
    const modelList = all
        .map(m => `  ${m.provider}/${m.id}`)
        .sort()
        .join("\n");
    return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
