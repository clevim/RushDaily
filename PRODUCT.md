# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: static HTML, CSS and JavaScript for the first playable slice; no build dependency until the core loop is validated.

## Users

The creator and a small group of close friends playing private fan-made daily duels.

## Product Purpose

RushDaily gives each player the same daily seed, a randomized but coherent Rush Duel deck, and a randomized enemy deck for a short solo battle.

## Positioning

The daily seed makes the challenge reproducible for everyone while deck construction keeps the randomness playable instead of arbitrary.

## Operating Context

Players open the web app, inspect the day's rule and received deck, then start a short duel against an AI opponent. The interface should work well on desktop and mobile browsers.

## Capabilities and Constraints

The project is private, non-commercial, fan-made, and not affiliated with Konami. It may use real Yu-Gi-Oh! Rush Duel card data, Portuguese card text, and card imagery for this personal use. YGOPRODeck data should be cached locally and images should not be hotlinked continuously. The first slice may use a simplified battle engine and a curated local fallback while the API sync is built.

Open decisions: exact rules coverage, multiplayer, persistence, deployment, and whether the long-term client should remain dependency-free or move to a framework.

## Brand Commitments

The product name is RushDaily. The interface should feel like a considered duel table with Rush Duel energy, not a generic AI dashboard or a direct copy of an official site.

## Evidence on Hand

YGOPRODeck API documentation and public repositories reviewed during discovery. No existing source files or branded assets are present in the workspace.

## Product Principles

- Every daily run must be reproducible.
- Randomness should create decisions, not dead hands.
- A duel should be understandable at a glance.
- The first screen should show the actual challenge, not marketing copy.
- Private fan-made use takes precedence over premature platform complexity.

## Accessibility & Inclusion

Support keyboard navigation, visible focus, readable contrast, reduced-motion preferences, and responsive layouts for small screens.
