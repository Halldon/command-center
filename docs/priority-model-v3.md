# Command Center Priority Model v3 (first-order + second-order + freshness decay)

Date: 2026-02-16

## Goal
Improve ranking quality for the Attention Queue by combining:
1. **First-order signal** (immediate severity/urgency)
2. **Second-order impact** (downstream cascade/business effects)
3. **Confidence decay by data freshness** (stale evidence should down-weight confidence)

Designed for deterministic snapshot generation + static JS dashboard rendering.

---

## 1) Core formulas (normalized 0..1)

### 1.1 First-order signal `S1`

```
S1 = 0.35*severity
   + 0.25*urgency
   + 0.20*slaRisk
   + 0.10*blastRadius
   + 0.10*trendVelocity
```

Where:
- `severity` from mapping (`critical=1.0`, `high=0.85`, `warn=0.60`, `info=0.30`)
- `urgency` from due/SLA horizon (overdue = `1.0`; <=30m `0.9`; <=2h `0.75`; <=6h `0.6`; <=24h `0.4`; else `0.2`)
- `slaRisk = overdue ? 1 : (1 - clamp(remainingMinutes/slaMinutes, 0, 1))`
- `blastRadius` from impacted systems/tags (0..1)
- `trendVelocity` from worsening trend slope (0..1)

### 1.2 Second-order impact `S2`

```
S2 = 0.40*propagationRisk
   + 0.30*businessImpact
   + 0.20*reversibilityPenalty
   + 0.10*dependencyCentrality
```

Where:
- `propagationRisk`: chance this issue causes additional incidents
- `businessImpact`: expected revenue/trust/compliance drag
- `reversibilityPenalty`: 1.0 if hard to rollback, near 0 if safely reversible
- `dependencyCentrality`: how central touched systems are

### 1.3 Confidence raw `C_raw`

```
C_raw = 0.45*evidenceCoverage
      + 0.35*sourceAgreement
      + 0.20*detectorReliability
```

- `evidenceCoverage = min(1, evidenceCount/3)`
- `sourceAgreement = 1 - contradictionRate`
- `detectorReliability` from source reliability map (e.g., control_tower: 0.9)

### 1.4 Freshness decay `D_fresh`

Use half-life decay by source class:

```
D_fresh = 2^(-ageMinutes / halfLifeMinutes[sourceClass])
C_eff   = clamp(C_raw * D_fresh, 0.10, 1.00)
```

Suggested half-lives:
- `incident/control_tower`: 180m
- `dashboard/jobs`: 180m
- `triage_queue`: 240m
- `telemetry`: 120m
- `backlog/manual`: 1440m

### 1.5 Final priority score `P`

```
P_base = 0.55*S1 + 0.30*S2 + 0.15*C_eff
P      = 100*P_base + breachBonus
breachBonus = 8 if sla.remainingMinutes < 0 else 0
P      = clamp(P, 0, 100)
```

Notes:
- First-order gets highest weight for operational responsiveness.
- Second-order prevents under-ranking latent cascade risks.
- Freshness reduces confidence contribution when data is stale.

---

## 2) Threshold bands

Priority bands (for action routing):

- **P0_FIRE**: `P >= 85` OR (`sla_breached` and `S1 >= 0.70`)
  - Immediate execution / page-level attention
- **P1_NOW**: `70 <= P < 85`
  - Start within 30 minutes
- **P2_TODAY**: `55 <= P < 70`
  - Resolve this work block
- **P3_DEFER**: `35 <= P < 55`
  - Defer with owner + review checkpoint
- **P4_IGNORE**: `P < 35`
  - Ignore/archive unless context changes

Confidence overlay badge:
- **CONF_HIGH**: `C_eff >= 0.75`
- **CONF_MED**: `0.45 <= C_eff < 0.75`
- **CONF_LOW**: `C_eff < 0.45` (show “revalidate data” hint)

Freshness badge:
- **fresh**: `D_fresh >= 0.70`
- **aging**: `0.40 <= D_fresh < 0.70`
- **stale**: `D_fresh < 0.40`

---

## 3) Example ranked items (deterministic sample)

Using the formulas above:

1. **Urgent incident: outreach snapshot stale** (incident)
   - `S1=0.945`, `S2=0.720`, `C_eff=0.624`, `P=90.9` → **P0_FIRE**
2. **Backfill sender health rows + validate collector source** (telemetry)
   - `S1=0.741`, `S2=0.690`, `C_eff=0.445`, `P=68.1` → **P2_TODAY** (high second-order risk, aging confidence)
3. **Failed cron: sync/publish snapshot** (dashboard)
   - `S1=0.724`, `S2=0.572`, `C_eff=0.740`, `P=68.1` → **P2_TODAY** (better confidence, lower cascade risk)
4. **Prepare weekly conversion summary** (backlog)
   - `S1=0.436`, `S2=0.490`, `C_eff=0.584`, `P=47.4` → **P3_DEFER**
5. **FYI newsletter digest** (automation)
   - `S1=0.150`, `S2=0.131`, `C_eff=0.175`, `P=14.8` → **P4_IGNORE**

Tie-breaker order when `|P_a - P_b| < 0.5`:
1) higher `S2`, 2) lower `remainingMinutes`, 3) newer `createdAt`.

---

## 4) Snapshot payload additions (backward compatible)

Per `attentionQueue.items[n]` add:

```json
"priority": {
  "modelVersion": "3.0.0",
  "firstOrder": 0.741,
  "secondOrder": 0.690,
  "confidenceRaw": 0.84,
  "freshness": {
    "ageMinutes": 220,
    "halfLifeMinutes": 240,
    "decay": 0.530
  },
  "confidenceEffective": 0.445,
  "breachBonus": 0,
  "score": 68.1,
  "band": "P2_TODAY",
  "confidenceBand": "CONF_LOW",
  "freshnessBand": "aging",
  "reasonCodes": ["TELEMETRY_GAP", "CASCADE_RISK"]
}
```

At `attentionQueue.model` add weights + thresholds for explainability in UI.

---

## 5) Implementation sketch

### Python (`build_command_center_snapshot.py`)

1. Add helper functions:
   - `score_first_order(item_ctx)`
   - `score_second_order(item_ctx)`
   - `score_confidence_raw(item_ctx)`
   - `freshness_decay(age_min, source_class)`
   - `priority_band(score, sla_breached, s1)`
2. Compute new `priority` object for each item.
3. Set legacy `item.score = priority.score` for compatibility.
4. Sort by `priority.score` (fallback to `item.score` for old entries).

### JS (`index.html`)

- Sort with fallback:
  ```js
  const scoreOf = (i) => i.priority?.score ?? i.score ?? 0;
  items.sort((a,b)=> (scoreOf(b)*attentionBias(b)) - (scoreOf(a)*attentionBias(a)));
  ```
- In row chip, show: `band · score · confidenceBand · freshnessBand`
- If `confidenceBand === "CONF_LOW"`, add “verify evidence freshness” tooltip.

---

## 6) Why this model is better

- Reduces false confidence from stale artifacts.
- Elevates cascade-prone issues before they become incidents.
- Keeps deterministic/static-host behavior (no runtime ML).
- Adds transparent sub-scores so operator can audit why an item ranked high.
