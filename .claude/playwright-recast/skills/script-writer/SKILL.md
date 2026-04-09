---
name: script-writer
description: Generate voiceover scripts and subtitles from technical video descriptions or Gherkin feature files. Transforms raw UI actions into benefit-driven marketing narration. Use when creating demo video scripts, voiceover text, SRT subtitles, or writing doc strings for playwright-bdd feature files.
---

# Script Writer

Transform technical descriptions of video content into polished voiceover scripts and subtitle text.

## When to Use

- User provides a technical description of what happens in a demo video
- User needs voiceover text or SRT subtitles for playwright-recast
- User asks to "write a script", "create narration", "write voiceover"
- User wants to write or improve doc strings in a `.feature` file
- User has a Gherkin scenario and needs narrator text for each step

## Input Sources

The script can be generated from:

1. **Free-form description** — raw text describing what happens in the video
2. **Gherkin feature file** — BDD steps with or without existing doc strings
3. **Existing SRT** — subtitle file that needs rewriting into marketing tone

## Gherkin Integration

playwright-recast + playwright-bdd uses Gherkin `.feature` files where **doc strings are the voiceover/subtitle text**:

```gherkin
Feature: Product demo

  Scenario: Setup monitoring
    When the user opens the chat
      """
      This doc string becomes the voiceover and subtitle for this step.
      """
    And the user selects a skill
      """
      Each step gets its own doc string — one per video segment.
      """
```

**How it works:**

- Each BDD step (`Given`/`When`/`Then`/`And`) = one video segment
- The doc string (`"""..."""`) under each step = voiceover + subtitle for that segment
- playwright-recast extracts doc strings as `SubtitleEntry[]` via `.subtitlesFromTrace()`
- The step title (e.g., `the user opens the chat`) is the *technical action*
- The doc string is the *narrator text* — this is what the script-writer generates

**When writing doc strings:**

- One doc string per step — maps 1:1 to subtitle entries
- Keep each doc string short enough for a single subtitle display (1-2 sentences)
- The first step's doc string should contain the HOOK
- The last step's doc string should contain the RESULT + CTA
- Middle steps cover the SOLUTION / WALKTHROUGH

## Core Principle

Never describe the UI mechanically. Translate every action into **client value** — what it saves, simplifies, speeds up, or improves.

## Output Structure

Every script follows this 4-part arc:

### 1. HOOK

- Name the problem the video solves
- Can be a question
- Must immediately justify why the viewer should care

### 2. SOLUTION / WALKTHROUGH

- Each step = a benefit, not a UI description
- Frame the flow as solving the client's problem
- Explain what it saves, simplifies, accelerates, or clarifies

### 3. RESULT

- Concrete impact: efficiency, time saved, fewer errors, better overview
- Match the benefit to the feature shown

### 4. CTA

- Natural, non-pushy call to action
- Tied to the feature shown
- Motifs: learn more, simplify your work, save time, stay in control

## Writing Rules

- **Language:** Match the user's language or explicit request
- **Tone:** Professional, smart, clear, no hype
- **Audience:** Determined by context (corporate, legal, sales, technical)
- **Sentences:** Short to medium, varied rhythm. 1-2 sentences per step.
- **No filler:** Every sentence earns its place
- **Narrative arc:** Always follow Hook → Solution/Walkthrough → Result structure across visible steps
- **No meta:** Never write "the user clicks", "we see on screen" — describe what it *means*
- **No lists, headings, or quotes** inside the voiceover text
- **Merge rapid steps** into a single fluid sentence
- **TTS-ready:** Text must read well in ElevenLabs / OpenAI TTS
- **No dead air:** Every moment of the video has matching narration

## Output Format

Adapt output to the input source:

**From free-form description:**

```text
VOICEOVER:
[Continuous flowing text]

SUBTITLES:
[Same content split into short lines/blocks]
```

**From Gherkin feature file — produce the updated feature with doc strings:**

```gherkin
When the user opens the chat
  """
  [narrator text for this step]
  """
```

**SRT format (when requested):**

```text
1
00:00:00,000 --> 00:00:06,000
[subtitle text for segment 1]

2
00:00:06,001 --> 00:00:12,000
[subtitle text for segment 2]
```

## Constraints

- Never invent features not shown in the video
- If input is too technical, infer the client benefit from context
- If input is vague, ask for clarification before writing
- Match subtitle count to logical video segments (1 per step in Gherkin)
