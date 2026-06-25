const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const port = Number(process.env.PORT || 3000);
const publicDir = __dirname;
const storageRoot = path.resolve(process.env.BRAIN_STORAGE_DIR || path.join(os.homedir(), "Documents", "brain-pdf-bank"));
const indexPath = path.join(storageRoot, ".brain-files.json");
const maxUploadBytes = Number(process.env.BRAIN_MAX_UPLOAD_MB || 100) * 1024 * 1024;
const openAiModel = process.env.BRAIN_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini";
const analyzeMaxChars = Number(process.env.BRAIN_ANALYZE_MAX_CHARS || 28000);
const analyzeTimeoutMs = Number(process.env.BRAIN_ANALYZE_TIMEOUT_MS || 25000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, payload) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxUploadBytes * 1.4) throw Object.assign(new Error("Upload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

async function analyzeWithAi(payload) {
  const apiKey = process.env.OPENAI_API_KEY || "";
  if (!apiKey) throw Object.assign(new Error("AI analysis is not configured"), { status: 503 });

  const sourceText = compactAnalysisText(payload.text || "");
  const fallbackScore = clampScore(payload.fallbackScore);
  const fallbackAdhdScore = clampScore(payload.fallbackAdhdScore);
  const sourceAnchors = extractAnalysisAnchors(sourceText);
  const input = [
    `Name: ${String(payload.name || "untitled").slice(0, 160)}`,
    `Kind: ${String(payload.kind || "text").slice(0, 80)}`,
    `MIME: ${String(payload.mime || "").slice(0, 80)}`,
    `Heuristic autism fallback score: ${fallbackScore}/100`,
    `Heuristic ADHD fallback score: ${fallbackAdhdScore}/100`,
    "",
    "Distinctive details from this saved input:",
    ...(sourceAnchors.length ? sourceAnchors.map((anchor) => `- ${anchor}`) : ["- no short readable details extracted"]),
    "",
    "Saved input:",
    sourceText || "(no readable text supplied)",
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), analyzeTimeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openAiModel,
        store: false,
        reasoning: { effort: "medium" },
        max_output_tokens: 2200,
        instructions: [
          "You analyze one saved personal note or uploaded text for a private self-reference PDF bank.",
          "Return two nuanced private self-reference scores from 1 to 100 for this entry: autism-trait signal and ADHD-trait signal. These are not clinical diagnoses and not severity labels.",
          "Never output 0 for either score. A low score means this entry has weak trait-specific signal, not that the person has no traits.",
          "For autism, do not rely only on keywords. Read the actual situation, communication style, uncertainty, sensory detail, routine/change needs, masking, predictability needs, focused interests, overwhelm, support impact, and ADHD/executive-function context.",
          "For ADHD, do not rely only on keywords. Read attention regulation, executive-function load, starting/finishing tasks, time and organization friction, forgetfulness, impulsivity, restlessness, emotional regulation under task friction, hyperfocus, and functional impact.",
          "Choose exactly one short phrase from the saved input that is the strongest autism-trait signal and exactly one short phrase that is the strongest ADHD-trait signal. These phrases will be bolded in the generated PDF.",
          "Each bolded phrase must be copied from the saved input after normalizing whitespace. Prefer concrete trait evidence over bare self-label words such as autistic, autism, ASD, ADHD, diagnosis, or evaluation. If the whole note is weak-signal, still choose the strongest available personal pattern instead of a random topic phrase.",
          "The selected phrase must make sense by itself. It needs enough concrete context that a card reader can understand what it refers to without rereading the full note.",
          "Never select vague fragments such as 'about that every day', 'that every day', 'the thing', 'this is hard', 'about it', 'that part', 'while driving', 'ok so in the movie', 'this uncertainty is making me kind', or any phrase built mostly from pronouns. Expand to the surrounding concrete sentence or choose a better sentence.",
          "Never select a phrase that is only a topic label, tool mention, object mention, or random memorable sentence. Bad selections include phrases like 'i do a lot of prompting for codex and chatgpt', 'i mean theres silly and then theres hi hitler', 'thinking about research for the day, playing violin for the day', or 'sparkling water is like the same' unless the analysis can point to a concrete trait mechanism inside that exact wording.",
          "Never include ellipses, truncated quotes, trailing punctuation fragments, or preview-style clipped text in highlightText or adhdHighlightText. The selected phrase must be copied as a continuous exact phrase from the source.",
          "For ADHD, a good phrase must itself show attention load, task friction, time/memory/organization strain, impulsivity, restlessness, hyperfocus, or emotional regulation under executive load. Do not use a general anxiety phrase as ADHD evidence unless you explain the attention/executive part concretely.",
          "For autism, a good phrase must itself show predictability, sensory/body mapping, exactness, sameness, social meaning, masking, transition cost, or fixed-focus evidence. Do not use a general worry phrase as autism evidence unless the concrete autism-shaped mechanism is present.",
          "The autism phrase and ADHD phrase should be different unless the note only contains one concrete trait-shaped sentence. If they are the same, explain different mechanisms in each paragraph and keep one score lower when the second trait is weaker.",
          "If the note has weak signal for a trait, choose the least-bad concrete phrase and score it low. Do not make the quote or explanation sound stronger than the text actually supports.",
          "A strong autism phrase usually shows need for certainty or predictability, sensory/body safety, distress/overwhelm, difficulty with switching or change, masking, social-meaning confusion, literal rule dependence, or intense fixed focus.",
          "A strong ADHD phrase usually shows attention being interest-driven, starting or finishing friction, too many steps, time/memory/organization friction, quick switching, restlessness, emotional load from task friction, or hyperfocus.",
          "The phrase itself must contain the signal. Do not choose lead-in/setup words such as 'when I click', 'the thing', or 'the part is' unless the chosen phrase also contains the actual need, rule, discomfort, certainty, switching, masking, sensory, exactness, attention, task, time, memory, restlessness, impulsivity, or focus evidence.",
          "Prefer self-contained complete phrases with words like need, can't, only, should, make sure, exact, same, first, predictable, comfortable, safe, normal, switch, focus, or know. Do not end the phrase on a dangling word or half-thought like that, that's kind, while, to, I, can't, cant, like, of, or because.",
          "Every analysis must be unique because every saved input is unique. Do not reuse a template sentence from another input, and do not write a generic category summary that could fit another note.",
          "Do not start most paragraphs with the same phrase such as 'I read'. Vary the first sentence naturally across notes so neighboring cards do not look copied and pasted.",
          "Each paragraph must be anchored in this exact input. Name at least three concrete input-specific details, situations, or tensions from the distinctive-detail list or saved text when the note provides them. Include one sentence explaining why the chosen phrase is trait-shaped. Use short paraphrases, not long quotes.",
          "Make the autism and ADHD paragraphs parallel in shape and length. Each should be two compact complete sentences, about 150-260 characters, talk directly about its chosen phrase, then explain the score in normal human language.",
          "Do not repeat the chosen phrase verbatim inside the analysis paragraph. The phrase is already stored separately as highlightText or adhdHighlightText, so refer to it naturally as that line, that wording, or that phrase, then use other concrete details from the input. Do not say 'selected line'.",
          "Do not make the details scarce. Each analysis paragraph needs enough input-specific substance that it would not fit another note: include at least three concrete details besides the selected phrase whenever the input provides them.",
          "The ADHD paragraph must not sound like a separate clinical rubric or abstract executive-function lecture. Start from the chosen ADHD phrase when possible and explain how that exact phrase shows attention, task-starting, time, memory, restlessness, quick switching, frustration, or hyperfocus.",
          "Write like a careful human analyst, not a scoring formula. Do not list point math, hit counts, DSM fractions, or raw/cap language.",
          "Be direct but bounded: say what the entry suggests, what weighs most, and why the score is not higher or lower when relevant.",
          "Do not quote long sensitive passages. Keep analysis to one compact paragraph, and finish in complete sentences.",
        ].join("\n"),
        input,
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "brain_autism_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                score: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  description: "Autism-trait signal score for this entry only.",
                },
                analysis: {
                  type: "string",
                  minLength: 80,
                  maxLength: 420,
                  description: "One unique two-sentence human paragraph explaining the score without point math. It must be compact, parallel to the ADHD analysis, mention concrete details from this exact input, and avoid reusable template language.",
                },
                specificDetails: {
                  type: "array",
                  minItems: 2,
                  maxItems: 5,
                  description: "Short paraphrases of concrete details from this input that made the analysis unique.",
                  items: {
                    type: "string",
                    minLength: 4,
                    maxLength: 90,
                  },
                },
                highlightText: {
                  type: "string",
                  minLength: 4,
                  maxLength: 100,
                  description: "One exact 6-18 word self-contained phrase from the saved input that should be bolded as the strongest autism-trait signal. It must include concrete context, not just a pronoun fragment.",
                },
                highlightExplanation: {
                  type: "string",
                  minLength: 30,
                  maxLength: 280,
                  description: "One short human sentence explaining why the highlighted phrase is autism-shaped.",
                },
                adhdScore: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  description: "ADHD-trait signal score for this entry only.",
                },
                adhdAnalysis: {
                  type: "string",
                  minLength: 80,
                  maxLength: 420,
                  description: "One unique two-sentence human paragraph explaining the ADHD score without point math. It must be compact, parallel to the autism analysis, mention concrete details from this exact input, and avoid reusable template language.",
                },
                adhdSpecificDetails: {
                  type: "array",
                  minItems: 2,
                  maxItems: 5,
                  description: "Short paraphrases of concrete ADHD-relevant details from this input that made the analysis unique.",
                  items: {
                    type: "string",
                    minLength: 4,
                    maxLength: 90,
                  },
                },
                adhdHighlightText: {
                  type: "string",
                  minLength: 4,
                  maxLength: 100,
                  description: "One exact 6-18 word self-contained phrase from the saved input that should be bolded as the strongest ADHD-trait signal. It must include concrete context, not just a pronoun fragment.",
                },
                adhdHighlightExplanation: {
                  type: "string",
                  minLength: 30,
                  maxLength: 280,
                  description: "One short human sentence explaining why the highlighted phrase is ADHD-shaped.",
                },
              },
              required: ["score", "analysis", "specificDetails", "highlightText", "highlightExplanation", "adhdScore", "adhdAnalysis", "adhdSpecificDetails", "adhdHighlightText", "adhdHighlightExplanation"],
            },
          },
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || `OpenAI analysis failed (${response.status})`;
      throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : 400 });
    }
    return normalizeAiAnalysis(parseAiJson(body), fallbackScore, fallbackAdhdScore, sourceText.length, sourceAnchors, sourceText);
  } catch (error) {
    if (error?.name === "AbortError") throw Object.assign(new Error("AI analysis timed out"), { status: 504 });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function compactAnalysisText(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (text.length <= analyzeMaxChars) return text;
  const slice = Math.max(2000, Math.floor(analyzeMaxChars / 3));
  const head = text.slice(0, slice);
  const midpoint = Math.max(slice, Math.floor(text.length / 2) - Math.floor(slice / 2));
  const middle = text.slice(midpoint, midpoint + slice);
  const tail = text.slice(-slice);
  return [head, "\n\n[...middle excerpt...]\n\n", middle, "\n\n[...ending excerpt...]\n\n", tail].join("").slice(0, analyzeMaxChars + 80);
}

function parseAiJson(body) {
  const text = extractResponseText(body);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw Object.assign(new Error("AI analysis returned invalid JSON"), { status: 502 });
  }
}

function extractResponseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const parts = [];
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("").trim();
}

function normalizeAiAnalysis(value, fallbackScore, fallbackAdhdScore, textChars = 0, sourceAnchors = [], sourceText = "") {
  const score = clampScore(value?.score || fallbackScore || 1);
  const details = Array.isArray(value?.specificDetails)
    ? value.specificDetails.map((item) => cleanExplanation(item)).filter(Boolean).slice(0, 5)
    : [];
  const highlightText = normalizedHighlightText(value?.highlightText, sourceAnchors, sourceText, "autism");
  const highlightExplanation = cleanExplanation(value?.highlightExplanation).slice(0, 320);
  let analysis = cleanExplanation(value?.analysis);
  if (!analysis || analysis.length < 40) throw Object.assign(new Error("AI analysis was too short"), { status: 502 });
  analysis = removeRepeatedHighlightSentences(analysis, highlightText);
  analysis = trimIncompleteSentence(analysis);

  const adhdScore = clampScore(value?.adhdScore || fallbackAdhdScore || 1);
  const adhdDetails = Array.isArray(value?.adhdSpecificDetails)
    ? value.adhdSpecificDetails.map((item) => cleanExplanation(item)).filter(Boolean).slice(0, 5)
    : [];
  let adhdHighlightText = normalizedHighlightText(value?.adhdHighlightText, sourceAnchors, sourceText, "adhd");
  if (highlightText && comparableAnalysisText(adhdHighlightText) === comparableAnalysisText(highlightText)) {
    const alternate = bestSourceHighlight(sourceText, sourceAnchors, "adhd", adhdHighlightText);
    if (alternate && comparableAnalysisText(alternate) !== comparableAnalysisText(highlightText)) {
      adhdHighlightText = alternate;
    }
  }
  const adhdHighlightExplanation = cleanExplanation(value?.adhdHighlightExplanation).slice(0, 320);
  let adhdAnalysis = cleanExplanation(value?.adhdAnalysis);
  if (!adhdAnalysis || adhdAnalysis.length < 40) {
    adhdAnalysis = "This entry has limited ADHD-specific readable detail, so I keep the ADHD score close to the fallback and treat the result as a low-confidence signal rather than a diagnosis.";
  }
  adhdAnalysis = removeRepeatedHighlightSentences(adhdAnalysis, adhdHighlightText);
  adhdAnalysis = trimIncompleteSentence(adhdAnalysis);
  return {
    score: Math.max(1, score),
    explanation: cleanExplanation(analysis).slice(0, 1100),
    highlightText,
    highlightExplanation,
    adhdScore: Math.max(1, adhdScore),
    adhdExplanation: cleanExplanation(adhdAnalysis).slice(0, 1100),
    adhdHighlightText,
    adhdHighlightExplanation,
    model: openAiModel,
    textChars: Math.max(0, Number(textChars || 0)),
  };
}

function normalizedHighlightText(value, anchors = [], sourceText = "", trait = "autism") {
  const text = cleanExplanation(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\*\*/g, "")
    .trim();
  if (text.split(/\s+/).filter(Boolean).length >= 2) {
    const phrase = completeHighlightPhrase(text, sourceText);
    return isWeakHighlight(phrase, trait) || !sourceContainsPhrase(sourceText, phrase)
      ? bestSourceHighlight(sourceText, anchors, trait, phrase)
      : phrase;
  }
  const fallback = anchors.find((anchor) => String(anchor || "").split(/\s+/).filter(Boolean).length >= 2) || "";
  const phrase = shortHighlightPhrase(text || fallback);
  return isWeakHighlight(phrase, trait) || !sourceContainsPhrase(sourceText, phrase)
    ? bestSourceHighlight(sourceText, anchors, trait, phrase)
    : phrase;
}

function completeHighlightPhrase(value, sourceText = "") {
  const phrase = shortHighlightPhrase(bestCompleteHighlightSegment(value, 18), 18);
  if (!phrase || !isDanglingHighlight(phrase)) return phrase;
  const source = cleanExplanation(sourceText).replace(/\s+/g, " ");
  if (!source) return phrase;
  const pattern = new RegExp(phrase.split(/\s+/).map(escapeRegex).join("\\s+"), "i");
  const match = pattern.exec(source);
  if (!match) return phrase;
  const words = source.slice(match.index).split(/\s+/).filter(Boolean).slice(0, 18).join(" ");
  const sentence = words.match(/^(.+?[.!?;:])(?:\s|$)/)?.[1] || words;
  return shortHighlightPhrase(sentence.replace(/[.!?;:]+$/g, ""), 18);
}

function bestCompleteHighlightSegment(value, maxWords = 18) {
  const text = stripHighlightLeadIn(cleanExplanation(value).replace(/\s+/g, " ").trim());
  if (!text) return "";
  const parts = text.split(/\s+(?:because|but|so|and then|and i|and it|when|whereas|which)\s+|\s*\(/i)
    .map((part) => part.trim())
    .filter((part) => part.split(/\s+/).filter(Boolean).length >= 3);
  const candidates = [text, ...parts];
  return candidates.sort((a, b) => highlightSegmentScore(b, maxWords) - highlightSegmentScore(a, maxWords))[0] || text;
}

function stripHighlightLeadIn(value) {
  return String(value || "")
    .replace(/^(?:and|but|so)\s+/i, "")
    .trim();
}

function highlightSegmentScore(value, maxWords) {
  const text = cleanExplanation(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (words >= 4) score += 20;
  if (words <= maxWords) score += 20;
  if (!isDanglingHighlight(text)) score += 12;
  if (/\b(?:focus|attention|concentrat|interesting|boring|task|start|finish|time|forget|organize|priority|frustrat|overwhelm|restless|fidget|impuls|hyperfocus)\b/.test(text)) score += 18;
  if (/\b(?:predict|certainty|uncertain|know|safe|comfort|sensory|same|switch|routine|social|mask|exact|rule|pattern|body)\b/.test(text)) score += 12;
  if (isWeakHighlight(text, "adhd") && isWeakHighlight(text, "autism")) score -= 45;
  if (words > maxWords) score -= 20;
  return score - Math.abs(words - Math.min(maxWords, 10));
}

function bestSourceHighlight(sourceText = "", anchors = [], trait = "autism", avoided = "") {
  const candidates = [
    ...sourceHighlightCandidates(sourceText),
    ...anchors.map((anchor) => cleanExplanation(anchor)).filter(Boolean),
  ];
  const ranked = candidates
    .map((candidate, index) => {
      const phrase = completeHighlightPhrase(candidate, sourceText);
      return {
        phrase,
        index,
        score: sourceHighlightScore(phrase, trait, avoided),
      };
    })
    .filter((item) => item.phrase)
    .filter((item) => sourceContainsPhrase(sourceText, item.phrase))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const usable = avoided
    ? ranked.filter((item) => comparableAnalysisText(item.phrase) !== comparableAnalysisText(avoided))
    : ranked;
  const best = usable.find((item) => !isWeakHighlight(item.phrase, trait))
    || usable.find((item) => !isBadHighlightFragment(item.phrase))
    || usable[0]
    || ranked[0];
  return best?.phrase || shortHighlightPhrase(sourceHighlightCandidates(sourceText)[0] || sourceText, 18);
}

function sourceHighlightCandidates(sourceText = "") {
  const text = repairQuestionArtifacts(String(sourceText || "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "")).replace(/\s+/g, " ").trim();
  if (!text) return [];
  const chunks = [];
  const sentenceParts = text.split(/(?<=[.!?;])\s+|,\s+|[()]/i);
  for (const part of sentenceParts) {
    const clean = cleanExplanation(part);
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 5 && words.length <= 26) chunks.push(clean);
    if (words.length > 18) {
      for (let index = 0; index <= words.length - 6; index += 4) {
        chunks.push(words.slice(index, index + 18).join(" "));
      }
    }
  }
  return chunks.filter((item, index, list) => list.findIndex((other) => anchorSimilarity(item, other) > 0.82) === index);
}

function sourceHighlightScore(value, trait, avoided = "") {
  const text = cleanExplanation(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = highlightSegmentScore(text, 18);
  if (trait === "adhd") score += adhdPhraseSignal(text) * 16 + autismPhraseSignal(text) * 2;
  else score += autismPhraseSignal(text) * 16 + adhdPhraseSignal(text) * 2;
  if (/\bi\b|\bmy\b|\bme\b/.test(text)) score += 6;
  if (words >= 6 && words <= 16) score += 10;
  if (isWeakHighlight(text, trait)) score -= 60;
  if (avoided && comparableAnalysisText(text) === comparableAnalysisText(avoided)) score -= 300;
  return score;
}

function adhdPhraseSignal(text) {
  const value = cleanExplanation(text).toLowerCase();
  const patterns = [
    /\bpay attention\b/,
    /\bfocus|concentrat|distract|attention\b/,
    /\btask|start|finish|step|organize|priority|plan|time|deadline|remember|forget|memory\b/,
    /\bfrustrat|overwhelm|annoy|stress|restless|fidget|impuls|hyperfocus|switch\b/,
    /\bcan'?t keep|keep track|too many|all at once\b/,
  ];
  return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
}

function autismPhraseSignal(text) {
  const value = cleanExplanation(text).toLowerCase();
  const patterns = [
    /\bpredict|certainty|uncertain|know exactly|make sure|assume|rule\b/,
    /\bsame|consistent|routine|stable|switch|change|transition\b/,
    /\bsensory|sound|texture|comfortable|comfort|safe|safety|body|spatial|blind spot|every inch\b/,
    /\bsocial|conversation|relationship|mask|normal|tone|misread\b/,
    /\bexact|precise|pattern|category|fixed|interest|all the details\b/,
    /\boverwhelm|panic|shutdown|too much\b/,
  ];
  return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
}

function isWeakHighlight(value, trait = "") {
  const text = cleanExplanation(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (isBadHighlightFragment(text)) return true;
  const pronouns = words.filter((word) => /^(?:i|me|my|it|that|this|they|them|he|she|we|you|something|thing|stuff)$/i.test(word)).length;
  if (pronouns / words.length > 0.45) return true;
  if (trait === "adhd" && adhdPhraseSignal(text) === 0 && words.length < 8) return true;
  if (trait === "autism" && autismPhraseSignal(text) === 0 && words.length < 8) return true;
  return false;
}

function isBadHighlightFragment(value) {
  const text = cleanExplanation(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  if (!text || words.length < 5) return true;
  if (isDanglingHighlight(text)) return true;
  if (/^(?:about|that|this|it|the thing|thing|stuff|while|when|because|like|ok so)\b/.test(text)) return true;
  if (/\b(?:about that every day|that every day|about it|that part|the thing|this thing|that thing|while driving|kind of frustrating because i don't know|this uncertainty is making me kind|i was telling me how this is the same thing)\b/.test(text)) return true;
  if (/\.\.\.|…/.test(text)) return true;
  if (/\b(?:i do a lot of prompting for codex and chatgpt|does a lot of prompting for codex and chatgpt|i mean theres silly and then theres hi hitler|thinking about research for the day|playing violin for the day|sparkling water is like the same|relationships are fucking learning all the time|the main strain is starting not the topics themselves)\b/.test(text)) return true;
  return false;
}

function sourceContainsPhrase(sourceText = "", phrase = "") {
  const source = sourceComparableText(sourceText);
  const text = sourceComparableText(phrase);
  if (!source || !text) return false;
  const pattern = new RegExp(text.split(/\s+/).map(escapeRegex).join("\\s+"), "i");
  return pattern.test(source);
}

function sourceComparableText(value) {
  return repairQuestionArtifacts(String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isDanglingHighlight(value) {
  const text = cleanExplanation(value).toLowerCase();
  return /\b(?:kind of|sort of|a lot of|one of|because of)$/.test(text)
    || /\b(?:that|that's|to|i|im|i'm|cant|can't|cannot|because|like|of|for|with|while|when|if|the|a|an|and|or|but|so|as)$/.test(text)
    || /\b(?:that's|that is)\s+kind$/.test(text);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortHighlightPhrase(value, maxWords = 18) {
  const words = cleanExplanation(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const output = words.slice(0, Math.max(1, maxWords));
  while (output.length < words.length && isDanglingHighlight(output.join(" "))) {
    output.push(words[output.length]);
  }
  while (output.length > 1 && isDanglingHighlight(output.join(" "))) {
    output.pop();
  }
  return output.join(" ").slice(0, 160).trim();
}

function trimIncompleteSentence(value) {
  const text = cleanExplanation(value);
  if (!text || /[.!?]["')\]]?$/.test(text)) return text;
  const lastStop = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"));
  if (lastStop >= 80) return text.slice(0, lastStop + 1).trim();
  return text;
}

function removeRepeatedHighlightSentences(value, highlightText) {
  const text = cleanExplanation(value);
  const phrase = comparableAnalysisText(highlightText);
  if (!text || !phrase) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [text];
  const kept = sentences
    .map((sentence) => cleanExplanation(sentence))
    .filter((sentence, index) => {
      const comparable = comparableAnalysisText(sentence);
      if (!comparable.includes(phrase)) return true;
      if (/center of|selected|highlight|bolded|phrase|matters because|is .*shaped|is .*read/i.test(sentence)) return false;
      return !(index === 0 && comparable.indexOf(phrase) <= 4);
    });
  return (kept.length ? kept.join(" ") : text).replace(/\s+/g, " ").trim();
}

function comparableAnalysisText(value) {
  return cleanExplanation(value)
    .toLowerCase()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAnalysisAnchors(value) {
  const text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  const clauses = text
    .split(/[\n.!?;]+|,\s+(?=(?:and|but|because|when|while|then|so|if|the|i)\b)/i)
    .map((part) => cleanAnchor(part))
    .filter(Boolean);
  const scored = clauses.map((clause, index) => ({
    clause,
    index,
    score: anchorScore(clause),
  }));
  return scored
    .filter((item) => item.score > 0 || item.clause.split(/\s+/).length >= 6)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.clause)
    .filter((item, index, list) => list.findIndex((other) => anchorSimilarity(item, other) > 0.72) === index)
    .slice(0, 5);
}

function cleanAnchor(value) {
  let text = String(value || "")
    .replace(/^[\s\-*\u2022\d.)\]]+/, "")
    .replace(/\b(and|but|because|so)\s+\1\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i < 3; i += 1) {
    text = text
      .replace(/^(?:,|\.)+\s*/, "")
      .replace(/^(?:and|but|because|so|then|while|when)\b[\s,]*/i, "")
      .trim();
  }
  if (/\b(?:application\/pdf|pdf generated|generated pdf|autism score|adhd score|score \d|synced -|browser heuristic)\b/i.test(text)) return "";
  if (/^(?:this entry|this note|the note|i read|the selected|the phrase|the concrete pieces|other concrete details|the autism-relevant|the adhd-relevant)\b/i.test(text)) return "";
  if (/\b(?:autism-shaped|adhd-shaped|autism-trait signal|adhd-trait signal|diagnostic-letter range|low-signal|high-signal saved note)\b/i.test(text)) return "";
  if (!text || text.length < 12) return "";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return "";
  const clipped = words.length > 18 ? `${words.slice(0, 18).join(" ")}...` : words.join(" ");
  return clipped.slice(0, 140);
}

function anchorScore(value) {
  const text = String(value || "").toLowerCase();
  let score = 0;
  const patterns = [
    /\bpredict|certainty|uncertain|proof|know|what'?s going to happen|if\b/,
    /\bsound|noise|comfort|comfortable|safe|safety|body|texture|light|bumpy|metal box\b/,
    /\bsocial|conversation|relationship|respond|text|tone|misread|confus|block|love\b/,
    /\broutine|switch|transition|change|same|stable|commit|back and forth\b/,
    /\boverwhelm|panic|shutdown|meltdown|stress|anxiety|hard to handle|too much\b/,
    /\bfocus|fixed|interest|exact|details|pattern|rule|category|audi|car\b/,
    /\bmask|normal|fit in|hide|compensat|camouflag\b/,
    /\badhd|executive function|attention|hyperfocus\b/,
    /\bautis|asd|diagnos|evaluation|assessment\b/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) score += 3;
  }
  if (/\bi\b|\bme\b|\bmy\b/.test(text)) score += 1;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 7 && words <= 18) score += 1;
  return score;
}

function anchorSimilarity(a, b) {
  const left = new Set(String(a || "").toLowerCase().split(/[^a-z0-9']+/).filter((token) => token.length >= 4));
  const right = new Set(String(b || "").toLowerCase().split(/[^a-z0-9']+/).filter((token) => token.length >= 4));
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap += 1;
  }
  return overlap / Math.min(left.size, right.size);
}

function dataUrlToBuffer(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) throw Object.assign(new Error("Invalid file payload"), { status: 400 });
  const mime = match[1] || "application/octet-stream";
  const encoded = match[3] || "";
  const data = match[2] ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8");
  return { mime, data };
}

function sanitizeFileName(name) {
  const cleaned = String(name || "brain-file")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || "brain-file";
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await fsp.readFile(indexPath, "utf8"));
    return Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [];
  }
}

async function writeIndex(files) {
  await fsp.mkdir(storageRoot, { recursive: true });
  await fsp.writeFile(indexPath, JSON.stringify({ files }, null, 2));
}

async function saveUploadedFile(payload) {
  const decoded = dataUrlToBuffer(payload.dataUrl);
  if (decoded.data.length > maxUploadBytes) throw Object.assign(new Error("Upload too large"), { status: 413 });
  const preview = payload.previewDataUrl ? dataUrlToBuffer(payload.previewDataUrl) : null;
  if (preview && !String(preview.mime || "").startsWith("image/")) throw Object.assign(new Error("Invalid preview payload"), { status: 400 });

  const id = crypto.randomUUID();
  const name = sanitizeFileName(payload.name);
  const storageName = `${id}-${name}`;
  const filePath = path.join(storageRoot, storageName);
  await fsp.mkdir(storageRoot, { recursive: true });
  await fsp.writeFile(filePath, decoded.data);
  let previewStorageName = "";
  let previewMime = "";
  if (preview) {
    previewStorageName = `${id}-preview.png`;
    previewMime = preview.mime || "image/png";
    await fsp.writeFile(path.join(storageRoot, previewStorageName), preview.data);
  }

  const requestedCreatedAt = payload.createdAt ? new Date(payload.createdAt) : null;
  const now = requestedCreatedAt && !Number.isNaN(requestedCreatedAt.getTime()) ? requestedCreatedAt.toISOString() : new Date().toISOString();
  const entry = {
    id,
    name,
    mime: payload.mime || decoded.mime || "application/octet-stream",
    size: decoded.data.length,
    createdAt: now,
    sourceCreatedAt: payload.sourceCreatedAt || "",
    kind: payload.kind || "file",
    pages: Number(payload.pages || 0),
    autismScore: clampScore(payload.autismScore),
    autismScoreExplanation: cleanExplanation(payload.autismScoreExplanation),
    autismHighlightText: cleanExplanation(payload.autismHighlightText).slice(0, 160),
    autismHighlightExplanation: cleanExplanation(payload.autismHighlightExplanation).slice(0, 360),
    autismScoreSource: scoreSource(payload.autismScoreSource),
    autismScoreModel: cleanExplanation(payload.autismScoreModel).slice(0, 80),
    autismScoreConfidence: scoreConfidence(payload.autismScoreConfidence),
    autismScoreWarning: cleanExplanation(payload.autismScoreWarning).slice(0, 180),
    autismTextChars: Math.max(0, Number(payload.autismTextChars || 0)),
    adhdScore: clampScore(payload.adhdScore),
    adhdScoreExplanation: cleanExplanation(payload.adhdScoreExplanation),
    adhdHighlightText: cleanExplanation(payload.adhdHighlightText).slice(0, 160),
    adhdHighlightExplanation: cleanExplanation(payload.adhdHighlightExplanation).slice(0, 360),
    adhdScoreSource: scoreSource(payload.adhdScoreSource),
    adhdScoreModel: cleanExplanation(payload.adhdScoreModel).slice(0, 80),
    adhdScoreConfidence: scoreConfidence(payload.adhdScoreConfidence),
    adhdScoreWarning: cleanExplanation(payload.adhdScoreWarning).slice(0, 180),
    adhdTextChars: Math.max(0, Number(payload.adhdTextChars || 0)),
    sourceText: cleanSourceText(payload.sourceText),
    generatedNoteLayoutVersion: cleanExplanation(payload.generatedNoteLayoutVersion).slice(0, 80),
    analysisQualityVersion: cleanExplanation(payload.analysisQualityVersion).slice(0, 80),
    storageName,
    previewStorageName,
    previewMime,
  };
  const files = await readIndex();
  files.unshift(entry);
  await writeIndex(files);
  return entry;
}

function publicEntry(entry) {
  const { storageName, previewStorageName, previewMime, ...rest } = entry;
  return { ...rest, hasPreview: Boolean(previewStorageName), previewMime: previewMime || "" };
}

async function rebuildGeneratedEntry(id, payload) {
  const { files, entry } = await findEntry(id);
  if (!entry) throw Object.assign(new Error("File not found"), { status: 404 });
  if ((entry.kind || "").toLowerCase() !== "generated pdf" || entry.mime !== "application/pdf") {
    throw Object.assign(new Error("Only generated PDFs can be rebuilt"), { status: 400 });
  }
  const decoded = dataUrlToBuffer(payload.dataUrl);
  if (decoded.data.length > maxUploadBytes) throw Object.assign(new Error("Upload too large"), { status: 413 });
  const preview = payload.previewDataUrl ? dataUrlToBuffer(payload.previewDataUrl) : null;
  if (preview && !String(preview.mime || "").startsWith("image/")) throw Object.assign(new Error("Invalid preview payload"), { status: 400 });
  const filePath = path.resolve(storageRoot, entry.storageName || "");
  if (!isInside(storageRoot, filePath)) throw Object.assign(new Error("Invalid file path"), { status: 403 });
  await fsp.writeFile(filePath, decoded.data);
  if (preview) {
    if (!entry.previewStorageName) entry.previewStorageName = `${entry.id}-preview.png`;
    const previewPath = path.resolve(storageRoot, entry.previewStorageName);
    if (!isInside(storageRoot, previewPath)) throw Object.assign(new Error("Invalid preview path"), { status: 403 });
    await fsp.writeFile(previewPath, preview.data);
    entry.previewMime = preview.mime || "image/png";
  }
  entry.size = decoded.data.length;
  entry.pages = Number(payload.pages || entry.pages || 0);
  entry.sourceText = cleanSourceText(payload.sourceText || entry.sourceText);
  entry.generatedNoteLayoutVersion = cleanExplanation(payload.generatedNoteLayoutVersion).slice(0, 80);
  if (payload.analysisQualityVersion !== undefined) entry.analysisQualityVersion = cleanExplanation(payload.analysisQualityVersion).slice(0, 80);
  if (payload.autismScore !== undefined) entry.autismScore = clampScore(payload.autismScore);
  if (payload.autismScoreExplanation !== undefined) entry.autismScoreExplanation = cleanExplanation(payload.autismScoreExplanation);
  if (payload.autismHighlightText !== undefined) entry.autismHighlightText = cleanExplanation(payload.autismHighlightText).slice(0, 160);
  if (payload.autismHighlightExplanation !== undefined) entry.autismHighlightExplanation = cleanExplanation(payload.autismHighlightExplanation).slice(0, 360);
  if (payload.autismScoreSource !== undefined) entry.autismScoreSource = scoreSource(payload.autismScoreSource);
  if (payload.autismScoreModel !== undefined) entry.autismScoreModel = cleanExplanation(payload.autismScoreModel).slice(0, 80);
  if (payload.autismScoreConfidence !== undefined) entry.autismScoreConfidence = scoreConfidence(payload.autismScoreConfidence);
  if (payload.autismScoreWarning !== undefined) entry.autismScoreWarning = cleanExplanation(payload.autismScoreWarning).slice(0, 180);
  if (payload.autismTextChars !== undefined) entry.autismTextChars = Math.max(0, Number(payload.autismTextChars || 0));
  if (payload.adhdScore !== undefined) entry.adhdScore = clampScore(payload.adhdScore);
  if (payload.adhdScoreExplanation !== undefined) entry.adhdScoreExplanation = cleanExplanation(payload.adhdScoreExplanation);
  if (payload.adhdHighlightText !== undefined) entry.adhdHighlightText = cleanExplanation(payload.adhdHighlightText).slice(0, 160);
  if (payload.adhdHighlightExplanation !== undefined) entry.adhdHighlightExplanation = cleanExplanation(payload.adhdHighlightExplanation).slice(0, 360);
  if (payload.adhdScoreSource !== undefined) entry.adhdScoreSource = scoreSource(payload.adhdScoreSource);
  if (payload.adhdScoreModel !== undefined) entry.adhdScoreModel = cleanExplanation(payload.adhdScoreModel).slice(0, 80);
  if (payload.adhdScoreConfidence !== undefined) entry.adhdScoreConfidence = scoreConfidence(payload.adhdScoreConfidence);
  if (payload.adhdScoreWarning !== undefined) entry.adhdScoreWarning = cleanExplanation(payload.adhdScoreWarning).slice(0, 180);
  if (payload.adhdTextChars !== undefined) entry.adhdTextChars = Math.max(0, Number(payload.adhdTextChars || 0));
  await writeIndex(files);
  return entry;
}

function scoreSource(value) {
  const source = String(value || "").toLowerCase().trim();
  return source === "ai" || source === "heuristic" ? source : "";
}

function scoreConfidence(value) {
  const confidence = String(value || "").toLowerCase().trim();
  return ["low", "medium", "high"].includes(confidence) ? confidence : "";
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cleanExplanation(value) {
  return repairQuestionArtifacts(String(value || "").replace(/\s+/g, " ").trim()).slice(0, 1200);
}

function cleanSourceText(value) {
  return repairQuestionArtifacts(String(value || "").replace(/\s+/g, " ").trim()).slice(0, 20000);
}

function repairQuestionArtifacts(value) {
  return String(value || "")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\?like\b/g, " like")
    .replace(/\?points\b/g, " points")
    .replace(/\?([^?\n]{1,90}?)\?/g, '"$1"')
    .replace(/([A-Za-z0-9])\?([a-z])/g, "$1'$2")
    .replace(/([A-Za-z0-9])\?([A-Z])/g, "$1'$2");
}

async function findEntry(id) {
  const files = await readIndex();
  return { files, entry: files.find((file) => file.id === id) };
}

async function serveStoredFile(req, res, requestUrl, id, mode) {
  const { entry } = await findEntry(id);
  if (!entry) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const isPreview = mode === "preview";
  const filePath = path.resolve(storageRoot, isPreview ? entry.previewStorageName || "" : entry.storageName || "");
  if (!isInside(storageRoot, filePath)) {
    sendJson(res, 403, { error: "Invalid file path" });
    return;
  }
  const disposition = mode === "download" ? "attachment" : "inline";
  res.writeHead(200, {
    "Content-Type": isPreview ? entry.previewMime || "image/png" : entry.mime || "application/octet-stream",
    "Content-Disposition": `${disposition}; filename="${encodeURIComponent(entry.name)}"`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

async function deleteStoredFile(req, res, id) {
  const { files, entry } = await findEntry(id);
  if (!entry) {
    sendJson(res, 404, { error: "File not found" });
    return;
  }
  const filePath = path.resolve(storageRoot, entry.storageName || "");
  if (isInside(storageRoot, filePath)) await fsp.rm(filePath, { force: true });
  const previewPath = path.resolve(storageRoot, entry.previewStorageName || "");
  if (entry.previewStorageName && isInside(storageRoot, previewPath)) await fsp.rm(previewPath, { force: true });
  await writeIndex(files.filter((file) => file.id !== id));
  sendJson(res, 200, { ok: true });
}

function sendStatic(req, res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const blockedNames = new Set(["server.js", "package.json", "railway.json"]);
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith(".")) || blockedNames.has(parts[parts.length - 1])) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(cleanPath)}`);
  if (!isInside(publicDir, filePath)) {
    sendJson(res, 403, { error: "Invalid path" });
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/api/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, app: "brain", storage: storageRoot, ai: Boolean(process.env.OPENAI_API_KEY), aiModel: openAiModel });
      return;
    }

    if (requestUrl.pathname === "/api/analyze" && req.method === "POST") {
      const analysis = await analyzeWithAi(await readJson(req));
      sendJson(res, 200, { analysis });
      return;
    }

    if (requestUrl.pathname === "/api/files" && req.method === "GET") {
      const files = (await readIndex()).map(publicEntry);
      sendJson(res, 200, { files });
      return;
    }

    if (requestUrl.pathname === "/api/files" && req.method === "POST") {
      const entry = await saveUploadedFile(await readJson(req));
      sendJson(res, 200, { file: publicEntry(entry) });
      return;
    }

    const rebuildMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)\/rebuild$/);
    if (rebuildMatch && req.method === "POST") {
      const entry = await rebuildGeneratedEntry(rebuildMatch[1], await readJson(req));
      sendJson(res, 200, { file: publicEntry(entry) });
      return;
    }

    const serveMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)\/(view|download|preview)$/);
    if (serveMatch && req.method === "GET") {
      await serveStoredFile(req, res, requestUrl, serveMatch[1], serveMatch[2]);
      return;
    }

    const deleteMatch = requestUrl.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      await deleteStoredFile(req, res, deleteMatch[1]);
      return;
    }

    sendStatic(req, res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(port, () => {
  console.log(`brain listening on ${port}`);
});
