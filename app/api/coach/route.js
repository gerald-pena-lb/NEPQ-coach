import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { NEPQ_SYSTEM_PROMPT } from '@/lib/salesFramework';

const anthropic = new Anthropic();

// Models: Sonnet for speed on main paths, Opus only for Go Deeper (quality matters more there)
const MODEL_FAST = 'claude-sonnet-4-6';
const MODEL_DEEP = 'claude-opus-4-6';

// System prompt with caching — the large NEPQ prompt is reused across every request.
// With cache_control: ephemeral, subsequent calls within 5 minutes get a ~85% TTFT reduction.
const SYSTEM_CACHED = [
  {
    type: 'text',
    text: NEPQ_SYSTEM_PROMPT,
    cache_control: { type: 'ephemeral' },
  },
];

const SYSTEM_CACHED_PREGEN = [
  {
    type: 'text',
    text:
      NEPQ_SYSTEM_PROMPT +
      `\n\n## PRE-GENERATION MODE\nReturn exactly 2 suggestions ranked by relevance. Format:\n{"candidates":[{"stage":"...","suggestions":[{"text":"...","why":"...","priority":N}],"prospectSentiment":"..."}]}\nEach candidate is a complete suggestion object. Rank by priority (1=best).`,
    cache_control: { type: 'ephemeral' },
  },
];

function buildConversationContext(conversationHistory, repCalibration, currentStage) {
  const fullHistory = (conversationHistory || []).slice(-60);
  const historyText = fullHistory.map((t, i) => `[${i + 1}] ${t.text}`).join('\n');

  const calibrationContext = repCalibration
    ? `\n\n[REP VOICE CALIBRATION — this is how the setter sounds: "${repCalibration}"]`
    : '';

  const stageContext = currentStage
    ? `\n\nCURRENT STAGE (the setter has set this): ${currentStage}\nGenerate suggestions appropriate for this stage.`
    : '';

  return { historyText, calibrationContext, stageContext };
}

function parseResponse(responseText, currentStage) {
  try {
    const cleaned = responseText
      .replace(/^```json?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.suggestions || parsed.suggestions.length === 0) {
      parsed.suggestions = [{ text: responseText.slice(0, 200), why: '', priority: 1 }];
    }
    parsed.suggestions = parsed.suggestions.map((s) => ({
      ...s,
      text: enforceSingleQuestion(s.text || ''),
    }));
    return parsed;
  } catch {
    return {
      stage: currentStage || 'COACHING',
      suggestions: [
        { text: enforceSingleQuestion(responseText.slice(0, 300)), why: '', priority: 1 },
      ],
      prospectSentiment: '',
    };
  }
}

function enforceSingleQuestion(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const firstQ = trimmed.indexOf('?');
  if (firstQ === -1) return trimmed;
  return trimmed.slice(0, firstQ + 1).trim();
}

// Jeremy speaks as if HE is the one on the call — not a sideline coach
const CONVERSATION_FRAMING = `

## HOW TO THINK ABOUT THIS
You ARE the setter. This is YOUR conversation with the prospect. Everything the setter has said in the transcript — treat it as YOUR words. The prospect is talking to YOU.

Read the ENTIRE transcript as if you're recalling your own conversation from memory. What have YOU already asked? What has the prospect told YOU? What thread are YOU currently pulling? What would YOU naturally say next — as someone who has been in this conversation the whole time, not someone who just overheard the last sentence?

Your suggestion should sound like the next natural thing YOU would say — not advice from a coach on the sideline. If the setter said something different from what you would have said, adapt: adopt what they said as your own and continue from there.

Never repeat a question. Reference the prospect's exact words. Output JSON only.`;

export async function POST(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    const {
      conversationHistory,
      latestText,
      repCalibration,
      currentStage,
      pregenerate,
      goDeeper,
      previousSuggestion,
    } = await request.json();

    const hasHistory = Array.isArray(conversationHistory) && conversationHistory.length > 0;
    const hasLatest = latestText && latestText.trim().length >= 5;
    if (!hasHistory && !hasLatest) {
      return NextResponse.json(
        { error: 'Not enough conversation context yet' },
        { status: 400 }
      );
    }

    const { historyText, calibrationContext, stageContext } =
      buildConversationContext(conversationHistory, repCalibration, currentStage);

    if (goDeeper && previousSuggestion) {
      const userMessage = `HERE IS YOUR CONVERSATION SO FAR (you are the setter, this is your call):\n${historyText}${calibrationContext}${stageContext}\n\nYou just considered saying:\n"${previousSuggestion}"\n\nBut that's too surface-level for where you are in the conversation. Go deeper. What would you REALLY say next — something that takes what the prospect told you and pushes past the logical layer into the emotional truth? Use their exact words. Don't repeat anything you've already asked.${CONVERSATION_FRAMING}`;

      const message = await anthropic.messages.create({
        model: MODEL_DEEP,
        max_tokens: 350,
        system: SYSTEM_CACHED,
        messages: [{ role: 'user', content: userMessage }],
      });

      const parsed = parseResponse(message.content[0]?.text || '', currentStage);
      return NextResponse.json(parsed);
    }

    if (pregenerate) {
      const userMessage = `HERE IS YOUR CONVERSATION SO FAR (you are the setter, this is your call):\n${historyText}${calibrationContext}${stageContext}\n\nYou're about to speak. Prepare 2 different things you might say next, ranked by which feels most natural for where the conversation is right now (priority 1 = best). Each must reference specific things the prospect told you. Don't repeat anything you already asked. Take different angles.${CONVERSATION_FRAMING}`;

      const message = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 500,
        system: SYSTEM_CACHED_PREGEN,
        messages: [{ role: 'user', content: userMessage }],
      });

      const responseText = message.content[0]?.text || '';

      let parsed;
      try {
        const cleaned = responseText
          .replace(/^```json?\s*/i, '')
          .replace(/```\s*$/, '')
          .trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = {
          candidates: [
            {
              stage: currentStage || 'COACHING',
              suggestions: [{ text: responseText.slice(0, 200), why: '', priority: 1 }],
              prospectSentiment: '',
            },
          ],
        };
      }

      let candidatesArr = parsed.candidates || parsed;
      if (!Array.isArray(candidatesArr)) candidatesArr = [candidatesArr];

      candidatesArr = candidatesArr
        .filter((c) => c.suggestions?.[0]?.text)
        .map((c) => ({
          stage: c.stage || currentStage || 'COACHING',
          suggestions: [
            {
              ...c.suggestions[0],
              text: enforceSingleQuestion(c.suggestions[0].text),
            },
          ],
          prospectSentiment: c.prospectSentiment || '',
        }));

      candidatesArr.sort(
        (a, b) => (a.suggestions[0].priority || 1) - (b.suggestions[0].priority || 1)
      );

      return NextResponse.json({ candidates: candidatesArr });
    }

    // Standard single-suggestion mode (on-demand fallback)
    const userMessage = `HERE IS YOUR CONVERSATION SO FAR (you are the setter, this is your call):\n${historyText}${calibrationContext}${stageContext}\n\nThe prospect just finished speaking. What would you say next? This should feel like the natural continuation of YOUR conversation — not advice from someone listening in.${CONVERSATION_FRAMING}`;

    const message = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 300,
      system: SYSTEM_CACHED,
      messages: [{ role: 'user', content: userMessage }],
    });

    const parsed = parseResponse(message.content[0]?.text || '', currentStage);
    return NextResponse.json(parsed);
  } catch (err) {
    console.error('Coaching error:', err);

    if (err.status === 401) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
    }
    if (err.status === 429) {
      return NextResponse.json(
        { error: 'Rate limited — try again' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to generate coaching suggestion' },
      { status: 500 }
    );
  }
}
