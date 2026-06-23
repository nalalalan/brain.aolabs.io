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
        reasoning: { effort: "low" },
        max_output_tokens: 1300,
        instructions: [
          "You analyze one saved personal note or uploaded text for a private self-reference PDF bank.",
          "Return two nuanced private self-reference scores from 1 to 100 for this entry: autism-trait signal and ADHD-trait signal. These are not clinical diagnoses and not severity labels.",
          "Never output 0 for either score. A low score means this entry has weak trait-specific signal, not that the person has no traits.",
          "For autism, do not rely only on keywords. Read the actual situation, communication style, uncertainty, sensory detail, routine/change needs, masking, predictability needs, focused interests, overwhelm, support impact, and ADHD/executive-function context.",
          "For ADHD, do not rely only on keywords. Read attention regulation, executive-function load, starting/finishing tasks, time and organization friction, forgetfulness, impulsivity, restlessness, emotional regulation under task friction, hyperfocus, and functional impact.",
          "Choose exactly one short phrase from the saved input that is the strongest autism-trait signal and exactly one short phrase that is the strongest ADHD-trait signal. These phrases will be bolded in the generated PDF.",
          "Each bolded phrase must be copied from the saved input after normalizing whitespace. Prefer concrete trait evidence over bare self-label words such as autistic, autism, ASD, ADHD, diagnosis, or evaluation. If the whole note is weak-signal, still choose the strongest available personal pattern instead of a random topic phrase.",
          "A strong autism phrase usually shows need for certainty or predictability, sensory/body safety, distress/overwhelm, difficulty with switching or change, masking, social-meaning confusion, literal rule dependence, or intense fixed focus.",
          "A strong ADHD phrase usually shows attention being interest-driven, starting or finishing friction, too many steps, time/memory/organization friction, quick switching, restlessness, emotional load from task friction, or hyperfocus.",
          "The phrase itself must contain the signal. Do not choose lead-in/setup words such as 'when I click', 'the thing', or 'the part is' unless the chosen phrase also contains the actual need, rule, discomfort, certainty, switching, masking, sensory, exactness, attention, task, time, memory, restlessness, impulsivity, or focus evidence.",
          "Prefer self-contained complete phrases with words like need, can't, only, should, make sure, exact, same, first, predictable, comfortable, safe, normal, switch, focus, or know. Do not end the phrase on a dangling word or half-thought like that, that's kind, while, to, I, can't, cant, like, of, or because.",
          "Every analysis must be unique because every saved input is unique. Do not reuse a template sentence from another input, and do not write a generic category summary that could fit another note.",
          "Do not start most paragraphs with the same phrase such as 'I read'. Vary the first sentence naturally across notes so neighboring cards do not look copied and pasted.",
          "Each paragraph must be anchored in this exact input. Name at least two concrete input-specific details, situations, or tensions from the distinctive-detail list or saved text. Include one sentence explaining why the chosen phrase is trait-shaped. Use short paraphrases, not long quotes.",
          "Make the autism and ADHD paragraphs parallel in shape and length. Each should be two compact complete sentences, about 150-260 characters, talk directly about its chosen phrase, then explain the score in normal human language.",
          "Do not repeat the chosen phrase verbatim inside the analysis paragraph. The phrase is already stored separately as highlightText or adhdHighlightText, so refer to it as the selected line, that line, or that phrase, then use other concrete details from the input.",
          "Do not make the details scarce. Each analysis paragraph needs enough input-specific substance that it would not fit another note: include at least two concrete details besides the selected phrase whenever the input provides them.",
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
                  description: "One exact 4-14 word phrase from the saved input that should be bolded as the strongest autism-trait signal.",
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
                  description: "One exact 4-14 word phrase from the saved input that should be bolded as the strongest ADHD-trait signal.",
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
  const highlightText = normalizedHighlightText(value?.highlightText, sourceAnchors, sourceText);
  const highlightExplanation = cleanExplanation(value?.highlightExplanation).slice(0, 320);
  let analysis = cleanExplanation(value?.analysis);
  if (!analysis || analysis.length < 40) throw Object.assign(new Error("AI analysis was too short"), { status: 502 });
  const anchors = [...sourceAnchors, ...details].map((item) => cleanExplanation(item)).filter(Boolean);
  analysis = removeRepeatedHighlightSentences(analysis, highlightText);
  if (anchors.length >= 2 && !analysisMentionsDetails(analysis, anchors)) {
    analysis = `${analysis} Other concrete details carry the read too: ${humanJoin(anchors.slice(0, 3))}.`;
  }
  if (highlightText && highlightExplanation && !analysisMentionsDetails(analysis, [highlightText, highlightExplanation])) {
    analysis = `${analysis} The selected autism line points to ${analysisPhraseFromExplanation(highlightExplanation)}.`;
  }
  analysis = trimIncompleteSentence(analysis);

  const adhdScore = clampScore(value?.adhdScore || fallbackAdhdScore || 1);
  const adhdDetails = Array.isArray(value?.adhdSpecificDetails)
    ? value.adhdSpecificDetails.map((item) => cleanExplanation(item)).filter(Boolean).slice(0, 5)
    : [];
  const adhdHighlightText = normalizedHighlightText(value?.adhdHighlightText, sourceAnchors, sourceText);
  const adhdHighlightExplanation = cleanExplanation(value?.adhdHighlightExplanation).slice(0, 320);
  let adhdAnalysis = cleanExplanation(value?.adhdAnalysis);
  if (!adhdAnalysis || adhdAnalysis.length < 40) {
    adhdAnalysis = "This entry has limited ADHD-specific readable detail, so I keep the ADHD score close to the fallback and treat the result as a low-confidence signal rather than a diagnosis.";
  }
  const adhdAnchors = [...sourceAnchors, ...adhdDetails].map((item) => cleanExplanation(item)).filter(Boolean);
  adhdAnalysis = removeRepeatedHighlightSentences(adhdAnalysis, adhdHighlightText);
  if (adhdAnchors.length >= 2 && !analysisMentionsDetails(adhdAnalysis, adhdAnchors)) {
    adhdAnalysis = `${adhdAnalysis} Other concrete details carry the read too: ${humanJoin(adhdAnchors.slice(0, 3))}.`;
  }
  if (adhdHighlightText && adhdHighlightExplanation && !analysisMentionsDetails(adhdAnalysis, [adhdHighlightText, adhdHighlightExplanation])) {
    adhdAnalysis = `${adhdAnalysis} The selected ADHD line points to ${analysisPhraseFromExplanation(adhdHighlightExplanation)}.`;
  }
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

function normalizedHighlightText(value, anchors = [], sourceText = "") {
  const text = cleanExplanation(value)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\*\*/g, "")
    .trim();
  if (text.split(/\s+/).filter(Boolean).length >= 2) return completeHighlightPhrase(text, sourceText);
  const fallback = anchors.find((anchor) => String(anchor || "").split(/\s+/).filter(Boolean).length >= 2) || "";
  return shortHighlightPhrase(text || fallback);
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
    .replace(/^i think\s+/i, "")
    .replace(/^i mean\s+/i, "")
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
  if (words > maxWords) score -= 20;
  return score - Math.abs(words - Math.min(maxWords, 10));
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

function lowercaseFirst(value) {
  const text = cleanExplanation(value);
  return text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : "";
}

function analysisPhraseFromExplanation(value) {
  return lowercaseFirst(cleanExplanation(value)
    .replace(/[.!?]+$/g, "")
    .replace(/^it shows\s+/i, "")
    .replace(/^it is\s+/i, "")
    .replace(/^the phrase is\s+/i, "")
    .replace(/^the line is\s+/i, ""));
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

function analysisMentionsDetails(analysis, details) {
  const text = analysis.toLowerCase();
  const tokens = new Set(
    details
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((token) => token.length >= 5)
  );
  let matches = 0;
  for (const token of tokens) {
    if (text.includes(token)) matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

function humanJoin(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
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
