// ---- State ----
let allUnits = [];
let currentPage = 1;
const UNITS_PER_PAGE = 60;

// Multi-filter state — each can be null (off) or a value
let filters = {
  type: null,      // "AGL", "TEQ", etc.
  rarity: null,    // "LR", "UR"
  class: null,     // "Super", "Extreme"
  category: null,  // category string
};

// ---- Load data from API ----
async function loadData() {
  try {
    // Fetch units and reddit insights in parallel
    const [unitsResp, redditResp] = await Promise.all([
      fetch("/api/units"),
      fetch("/api/reddit"),
    ]);
    const unitsData = await unitsResp.json();
    const redditData = await redditResp.json();

    // Set global EMBEDDED_REDDIT so blendCommunityInsights() can find it
    window.EMBEDDED_REDDIT = redditData;

    const raw = unitsData.units;
    allUnits = raw.map(u => normalizeUnit(u));
    document.getElementById("unitCount").textContent = allUnits.length + " units loaded";
    buildCategoryDropdown();
    renderList();
  } catch (err) {
    document.getElementById("unitCount").textContent = "Error loading data — make sure the server is running (node server.js)";
    console.error(err);
  }
}

// ---- Normalize the API data into our format ----
function normalizeUnit(raw) {
  const guide = blendCommunityInsights(analyzeUnit(raw), raw.id || raw.name);
  return {
    id: raw.id || raw.name,
    name: raw.name || "Unknown",
    title: raw.title || "",
    type: raw.type || "?",
    class: raw.class || "?",
    rarity: raw.rarity || "?",
    cost: raw.cost || 0,
    stats: {
      hp: raw.rainbowHP || raw.freeDupeHP || raw.maxLevelHP || 0,
      atk: raw.rainbowAttack || raw.freeDupeAttack || raw.maxLevelAttack || 0,
      def: raw.rainbowDefence || raw.freeDupeDefence || raw.maxDefence || 0,
    },
    leaderSkill: raw.leaderSkill || "None",
    passive: raw.passive || "None",
    superAttack: raw.superAttack || "None",
    ultraSuperAttack: raw.ultraSuperAttack || null,
    activeSkill: raw.activeSkill || null,
    activeSkillCondition: raw.activeSkillCondition || null,
    links: raw.links || [],
    categories: raw.categories || [],
    kiMultiplier: raw.kiMultiplier || null,
    transformations: raw.transformations || [],
    imageURL: raw.imageURL || null,
    ezaLeaderSkill: raw.ezaLeaderSkill || null,
    ezaSuperAttack: raw.ezaSuperAttack || null,
    ezaUltraSuperAttack: raw.ezaUltraSuperAttack || null,
    ezaPassive: raw.ezaPassive || null,
    ezaActiveSkill: raw.ezaActiveSkill || null,
    ezaActiveSkillCondition: raw.ezaActiveSkillCondition || null,
    hasEza: !!(raw.ezaPassive),
    transformType: raw.transformType || null,
    transformCondition: raw.transformCondition || null,
    exSuperAttack: raw.exSuperAttack || null,
    exSuperCondition: raw.exSuperCondition || null,
    slot: guide.slot,
    guide,
  };
}

// ---- Format passive as bullet points ----
function formatPassive(passiveText) {
  if (!passiveText || passiveText === "None") return "<p class='section-body'>None</p>";
  // Split on semicolons, "plus an additional", "and " at start of clauses, common passive separators
  let parts = passiveText
    .split(/;\s*/)
    .flatMap(p => p.split(/(?:^|\s)plus an additional\s/i))
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // If no splits happened, try splitting on long comma patterns
  if (parts.length <= 1) {
    parts = passiveText
      .split(/,\s*(?=[A-Z]|all |plus |when |if |per |at )/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
  }

  // Capitalize first letter of each
  parts = parts.map(p => p.charAt(0).toUpperCase() + p.slice(1));

  return `<ul class="passive-list">${parts.map(p => `<li>${escHtml(p)}</li>`).join("")}</ul>`;
}

// ---- Full unit analysis ----
function analyzeUnit(raw) {
  const p = (raw.passive || "").toLowerCase();
  const pOrig = raw.passive || "";
  const leader = (raw.leaderSkill || "").toLowerCase();
  const sa = (raw.superAttack || "").toLowerCase();
  const usa = (raw.ultraSuperAttack || "").toLowerCase();
  const isLR = raw.rarity === "LR";
  const unitType = (raw.type || "").toUpperCase();
  const unitClass = (raw.class || "").toLowerCase();
  const hasTransforms = (raw.transformations || []).length > 0;
  const hasActive = !!(raw.activeSkill);
  const activeCondition = (raw.activeSkillCondition || "").toLowerCase();

  // ========== MECHANIC DETECTION ==========
  // Stacking: "raises def" (no duration) = permanent, "raises def for 1 turn" = temporary
  function checkStack(text, stat) {
    const re = new RegExp("raises\\s+" + stat + "(?!.*?for\\s+\\d+\\s+turn)", "i");
    const reTemp = new RegExp("raises\\s+" + stat + ".*?for\\s+1\\s+turn", "i");
    const reGreatly = new RegExp("greatly\\s+raises\\s+" + stat + "(?!.*?for\\s+\\d+\\s+turn)", "i");
    const reGreatlyTemp = new RegExp("greatly\\s+raises\\s+" + stat + ".*?for\\s+1\\s+turn", "i");
    return {
      stacks: re.test(text),
      greatlyStacks: reGreatly.test(text),
      tempBoost: reTemp.test(text),
      greatlyTempBoost: reGreatlyTemp.test(text),
    };
  }
  const saDefInfo = checkStack(sa, "(?:atk & )?def");
  const usaDefInfo = checkStack(usa, "(?:atk & )?def");
  const saAtkInfo = checkStack(sa, "atk");
  const usaAtkInfo = checkStack(usa, "atk");

  const hasDefStack = saDefInfo.stacks || usaDefInfo.stacks;
  const hasDefTempBoost = saDefInfo.tempBoost || usaDefInfo.tempBoost;
  const hasGreatlyDefStack = saDefInfo.greatlyStacks || usaDefInfo.greatlyStacks;
  const hasAtkStack = saAtkInfo.stacks || usaAtkInfo.stacks;
  const hasAtkTempBoost = saAtkInfo.tempBoost || usaAtkInfo.tempBoost;

  // Core mechanics
  const hasDmgReduction = p.includes("damage reduction") || p.includes("damage received") || p.includes("reduces damage");
  const hasGuard = p.includes("guard") && (p.includes("all") || p.includes("activate"));
  const hasEvade = p.includes("evad") || p.includes("evasion") || p.includes("dodge");
  const hasDefOnHit = p.includes("def +") && (p.includes("when receiving") || p.includes("when attacked"));
  const hasAdditional = p.includes("additional attack") || p.includes("additional super");
  const hasCrit = p.includes("critical hit") || p.includes("performing a critical");
  const hasTypeEff = p.includes("effective against all") || p.includes("type effectiveness");
  const hasCounter = p.includes("counter");
  const hasSupport = p.includes("allies' atk") || p.includes("allies' def") || p.includes("all allies");
  const hasKiSupport = p.includes("ki +") && (p.includes("allies") || p.includes("all "));
  const hasDebuff = p.includes("enemy's atk") || p.includes("enemy's def") || p.includes("lowers");
  const hasSeal = sa.includes("seal") || usa.includes("seal") || p.includes("seals super") || p.includes("sealed");
  const hasStun = sa.includes("stun") || usa.includes("stun") || p.includes("stuns the") || p.includes("stunned");
  const hasHealing = p.includes("recover") || p.includes("restores hp");
  const hasEndOfTurnHeal = p.includes("at end of turn") && hasHealing;
  const hasSurviveKO = p.includes("survives k.o.") || p.includes("survive a k.o.");
  const hasDefRaise = hasDefStack || hasDefTempBoost;
  const hasAtkRaise = hasAtkStack || hasAtkTempBoost;
  const isTagUnit = (raw.transformType || "").toLowerCase().includes("tag") || (raw.name || "").includes("&");
  const isExchangeUnit = (raw.transformType || "").toLowerCase().includes("exchange");
  const isStandbyUnit = (raw.transformType || "").toLowerCase().includes("standby");
  const hasGuardAndDR = hasGuard && hasDmgReduction;
  const hasDodgeAndSurviveKO = hasEvade && hasSurviveKO;
  const stacksAtkNotDef = hasAtkStack && !hasDefStack;
  const stacksDefNotAtk = hasDefStack && !hasAtkStack;
  const needsSuperAllies = p.includes("super class") && (p.includes("allies") || p.includes("characters on the team"));
  const needsExtremeAllies = p.includes("extreme class") && (p.includes("allies") || p.includes("characters on the team"));

  // Advanced mechanics
  const hasForesee = p.includes("foresee");
  const hasNullify = p.includes("nullif");
  const hasRevive = p.includes("survives k.o.") || p.includes("reviv") || p.includes("revival");
  const hasDisableAction = p.includes("disable");
  const hasDisableGuard = p.includes("disables") && p.includes("guard");
  const hasOrbChange = p.includes("changes ki spheres") || p.includes("change") && p.includes("ki sphere");
  const hasPerAttack = p.includes("for every attack") || p.includes("per attack performed");

  // Slot-conditional mechanics (1st/2nd/3rd attacker)
  const hasSlot1Bonus = p.includes("as the 1st attacker");
  const hasSlot2Bonus = p.includes("as the 2nd attacker");
  const hasSlot3Bonus = p.includes("as the 3rd attacker");
  const hasSlot1or2 = p.includes("1st or 2nd");
  const hasSlot1or3 = p.includes("1st or 3rd");
  const hasSlot2or3 = p.includes("2nd or 3rd");
  const hasSlotConditional = hasSlot1Bonus || hasSlot2Bonus || hasSlot3Bonus || hasSlot1or2 || hasSlot1or3 || hasSlot2or3;

  // Once-only vs repeating effects
  // "(once only)" or "once within a turn" = happens once per battle/turn (yellow !1 icon in game)
  // No marker = repeats every turn (yellow ∞ icon in game)
  const hasOnceEffects = p.includes("once only") || p.includes("once within");
  // "(up to X%)" = stacking cap
  const hasStackCap = p.includes("up to");

  // ========== ADDITIVE PERCENTAGE CALCULATION ==========
  // Dokkan passives are additive: base values + conditional bonuses all stack.
  // We parse the passive into sections (Basic, slot conditions, Ki conditions, etc.)
  // and sum up the base + best-case conditional values per slot.
  function parseStatsBySection(passiveText) {
    // Split passive into conditional sections
    // Also track if a section contains "once only" or "once within" markers
    const sections = [];
    let current = { label: "base", text: "", hasOnce: false };
    const lines = passiveText.split(/;\s*/);
    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      if (lower.startsWith("as the 1st attacker")) { current = { label: "slot1", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.startsWith("as the 2nd attacker")) { current = { label: "slot2", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.startsWith("as the 3rd attacker")) { current = { label: "slot3", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.match(/^as the 1st or 2nd/)) { current = { label: "slot1or2", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.match(/^as the 1st or 3rd/)) { current = { label: "slot1or3", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.match(/^as the 2nd or 3rd/)) { current = { label: "slot2or3", text: "", hasOnce: false }; sections.push(current); continue; }
      if (lower.startsWith("when attacking") || lower.startsWith("when receiving") || lower.startsWith("basic effect")) {
        if (!current.label.startsWith("slot")) { current = { label: "base", text: "", hasOnce: false }; }
        sections.push(current);
        continue;
      }
      if (lower.includes("once only") || lower.includes("once within")) current.hasOnce = true;
      current.text += line + "; ";
    }
    if (current.text) sections.push(current);
    return sections;
  }

  function extractFromText(text, type) {
    const vals = [];
    if (type === "evade") {
      for (const m of text.matchAll(/evad(?:ing|e|ion)[^;]*?(\d+)%/gi)) vals.push(parseInt(m[1]));
      // Shared format: "critical hit, chance of evading...& damage reduction rate 30%"
      // The percentage at the end applies to all listed effects
      for (const m of text.matchAll(/evad[^,;]*?(?:&|,)[^;]*?(\d+)%/gi)) {
        const v = parseInt(m[1]);
        if (v > 0 && v <= 100 && !vals.includes(v)) vals.push(v);
      }
    } else if (type === "dr") {
      for (const m of text.matchAll(/damage reduction(?: rate)?\s+(\d+)%/gi)) vals.push(parseInt(m[1]));
    } else if (type === "crit") {
      // Direct: "critical hit 40%"
      for (const m of text.matchAll(/critical hit\s+(\d+)%/gi)) vals.push(parseInt(m[1]));
      // Shared format: "critical hit, chance of evading...rate 30%" — 30% applies to crit too
      for (const m of text.matchAll(/critical hit[^;]*?(?:rate|&)\s*(\d+)%/gi)) {
        const v = parseInt(m[1]);
        if (v > 0 && v <= 100 && !vals.includes(v)) vals.push(v);
      }
    }
    return vals.filter(n => n > 0 && n <= 100);
  }

  const sections = parseStatsBySection(pOrig);

  // Calculate base values (always active)
  let baseEvade = 0, baseDR = 0, baseCrit = 0;
  // Also track conditional values per slot
  let condEvade = { slot1: 0, slot2: 0, slot3: 0 };
  let condDR = { slot1: 0, slot2: 0, slot3: 0 };
  let condCrit = { slot1: 0, slot2: 0, slot3: 0 };

  for (const sec of sections) {
    const evadeVals = extractFromText(sec.text, "evade");
    const drVals = extractFromText(sec.text, "dr");
    const critVals = extractFromText(sec.text, "crit");
    const eSum = evadeVals.reduce((a,b) => a+b, 0);
    const dSum = drVals.reduce((a,b) => a+b, 0);
    const cSum = critVals.reduce((a,b) => a+b, 0);

    if (sec.label === "base") {
      baseEvade += eSum; baseDR += dSum; baseCrit += cSum;
    } else if (sec.label === "slot1") {
      condEvade.slot1 += eSum; condDR.slot1 += dSum; condCrit.slot1 += cSum;
    } else if (sec.label === "slot2") {
      condEvade.slot2 += eSum; condDR.slot2 += dSum; condCrit.slot2 += cSum;
    } else if (sec.label === "slot3") {
      condEvade.slot3 += eSum; condDR.slot3 += dSum; condCrit.slot3 += cSum;
    } else if (sec.label === "slot1or2") {
      condEvade.slot1 += eSum; condEvade.slot2 += eSum;
      condDR.slot1 += dSum; condDR.slot2 += dSum;
      condCrit.slot1 += cSum; condCrit.slot2 += cSum;
    } else if (sec.label === "slot1or3") {
      condEvade.slot1 += eSum; condEvade.slot3 += eSum;
      condDR.slot1 += dSum; condDR.slot3 += dSum;
      condCrit.slot1 += cSum; condCrit.slot3 += cSum;
    } else if (sec.label === "slot2or3") {
      condEvade.slot2 += eSum; condEvade.slot3 += eSum;
      condDR.slot2 += dSum; condDR.slot3 += dSum;
      condCrit.slot2 += cSum; condCrit.slot3 += cSum;
    }
  }

  // Total per slot = base + conditional
  const totalEvade = {
    slot1: Math.min(baseEvade + condEvade.slot1, 100),
    slot2: Math.min(baseEvade + condEvade.slot2, 100),
    slot3: Math.min(baseEvade + condEvade.slot3, 100),
  };
  const totalDR = {
    slot1: Math.min(baseDR + condDR.slot1, 100),
    slot2: Math.min(baseDR + condDR.slot2, 100),
    slot3: Math.min(baseDR + condDR.slot3, 100),
  };
  const totalCrit = {
    slot1: Math.min(baseCrit + condCrit.slot1, 100),
    slot2: Math.min(baseCrit + condCrit.slot2, 100),
    slot3: Math.min(baseCrit + condCrit.slot3, 100),
  };

  const maxEvade = Math.max(totalEvade.slot1, totalEvade.slot2, totalEvade.slot3);
  const maxDR = Math.max(totalDR.slot1, totalDR.slot2, totalDR.slot3);
  const maxCrit = Math.max(totalCrit.slot1, totalCrit.slot2, totalCrit.slot3);
  const bestEvadeSlot = totalEvade.slot1 >= totalEvade.slot2 && totalEvade.slot1 >= totalEvade.slot3 ? "slot 1" : totalEvade.slot3 >= totalEvade.slot2 ? "slot 3" : "slot 2";
  const bestCritSlot = totalCrit.slot1 >= totalCrit.slot2 && totalCrit.slot1 >= totalCrit.slot3 ? "slot 1" : totalCrit.slot2 >= totalCrit.slot3 ? "slot 2" : "slot 3";
  const totalEvadeMentions = (pOrig.match(/evad/gi) || []).length;

  // Derived flags that depend on maxEvade / hasNullify (defined above)
  const hasRawDefOnly = !hasDmgReduction && !hasGuard && !hasEvade && !hasNullify;
  const hasDodgeCancelVulnerability = hasEvade && maxEvade >= 30 && !hasGuard && !hasDmgReduction;

  // For backward compat
  const drPercents = [totalDR.slot1, totalDR.slot2, totalDR.slot3].filter(n => n > 0);

  // Extract ATK/DEF percentage boosts
  const atkDefMatch = pOrig.match(/ATK & DEF (\d+)%/);
  const atkDefPct = atkDefMatch ? parseInt(atkDefMatch[1]) : 0;

  const bigBadBosses = (raw.links || []).includes("Big Bad Bosses");

  // ========== SLOT ANALYSIS ==========
  let score1 = 0, score2 = 0, score3 = 0;
  let slotReasons = [];

  // Tanking (Slot 1)
  if (hasDmgReduction) {
    score1 += 3;
    if (maxDR >= 40) {
      slotReasons.push(`<strong>${maxDR}% total damage reduction</strong> (base ${baseDR}%${condDR.slot1 > 0 || condDR.slot3 > 0 ? " + conditional bonuses" : ""}) — extremely tanky.`);
    } else if (maxDR > 0) {
      slotReasons.push(`<strong>${maxDR}% damage reduction</strong>${baseDR !== maxDR ? ` (${baseDR}% base + conditional bonuses)` : ""} — solid damage mitigation.`);
    } else {
      slotReasons.push("Has damage reduction — takes less damage in slot 1.");
    }
  }
  if (hasGuard) { score1 += 4; slotReasons.push("Guards against all types — <strong>type disadvantage doesn't matter</strong>. Can tank any enemy."); }
  if (hasEvade) {
    const evadeScore = maxEvade >= 60 ? 5 : maxEvade >= 40 ? 4 : maxEvade >= 25 ? 3 : 2;
    score1 += evadeScore;
    const hasMultipleEvade = totalEvadeMentions > 1;
    if (maxEvade >= 60) {
      slotReasons.push(`<strong>Massive evasion (up to ${maxEvade}% in ${bestEvadeSlot})</strong>${baseDR > 0 ? ` (${baseEvade}% base + conditional bonuses stack on top)` : ""} — dodging is THE core defensive ability. Nearly untouchable in the right slot.`);
    } else if (maxEvade >= 40) {
      slotReasons.push(`<strong>High evasion (up to ${maxEvade}% in ${bestEvadeSlot})</strong>${hasMultipleEvade ? ` (${baseEvade}% base + slot bonuses that stack additively)` : ""} — dodging is a major part of this unit's kit.`);
    } else if (maxEvade >= 25) {
      slotReasons.push(`<strong>Solid evasion (up to ${maxEvade}%)</strong>${hasMultipleEvade ? ` (multiple evasion buffs stack)` : ""} — good dodge chance. Not guaranteed but significantly improves survivability.`);
    } else if (maxEvade > 0) {
      slotReasons.push(`Has evasion (${maxEvade}%) — can dodge attacks occasionally. Nice bonus but don't rely on it.`);
    } else {
      slotReasons.push("Has evasion — can dodge attacks. Helps avoid damage but it's RNG-based.");
    }
  }
  if (hasDefOnHit) { score1 += 2; slotReasons.push("Gets a DEF boost when attacked — gets tankier from taking hits."); }
  if (hasDefStack) { score1 += 2; score2 += 1; slotReasons.push("Permanently stacks DEF on super — gets tankier every turn. Keep on main rotation."); }
  if (hasDefTempBoost && !hasDefStack) { score1 += 1; slotReasons.push("Raises DEF for 1 turn on super — temporary boost that resets each turn. Does NOT stack."); }
  if (hasCounter) { score2 += 2; score1 += 1; slotReasons.push("Counters enemy attacks — place where attacks are landing for free extra damage."); }
  if (hasNullify) { score1 += 3; slotReasons.push("<strong>Can nullify enemy super attacks</strong> — one of the rarest and most powerful defensive abilities. Completely negates supers."); }
  if (hasRevive) { score1 += 2; slotReasons.push("<strong>Has a revive/survival mechanic</strong> — can survive a K.O. hit once per battle. Acts as a safety net in hard content."); }
  if (hasForesee) { score1 += 2; slotReasons.push("<strong>Can foresee enemy super attacks (Scouter)</strong> — lets you see where the enemy super is coming. Rearrange your units to put your best tank in that slot."); }

  // Damage (Slot 2)
  if (hasAdditional) {
    score2 += 3;
    const addlSuper = p.includes("additional super attack");
    slotReasons.push(addlSuper ? "Launches <strong>additional super attacks</strong> — extra damage AND extra super attack effects (stacking, debuffs, etc.)." : "Launches additional attacks — more damage and more chances to trigger effects.");
  }
  if (hasCrit) {
    const critScore = maxCrit >= 60 ? 4 : maxCrit >= 40 ? 3 : 2;
    score2 += critScore;
    if (maxCrit >= 60) {
      slotReasons.push(`<strong>Massive crit chance (up to ${maxCrit}% in ${bestCritSlot})</strong>${baseCrit !== maxCrit ? ` (${baseCrit}% base + conditional bonuses stack)` : ""} — crits most of the time. Devastating damage output.`);
    } else if (maxCrit >= 40) {
      slotReasons.push(`<strong>High crit chance (up to ${maxCrit}%${baseCrit !== maxCrit ? `, ${baseCrit}% base + bonuses` : ""})</strong> — frequently deals massive critical damage that ignores type.`);
    } else if (maxCrit >= 20) {
      slotReasons.push(`Good crit chance (up to ${maxCrit}%) — solid chance of dealing critical damage.`);
    } else {
      slotReasons.push("Has built-in critical hit chance — occasional big damage spikes.");
    }
  }
  if (hasTypeEff) { score2 += 3; slotReasons.push("<strong>Type effective against all</strong> — hits hard regardless of enemy type. Always deals boosted damage."); }
  if (hasDisableGuard) { score2 += 1; slotReasons.push("<strong>Disables enemy guard</strong> — ignores the enemy's type advantage when attacking."); }
  if (atkDefPct >= 200) score2 += 2;
  else if (atkDefPct >= 100) score2 += 1;
  if (hasPerAttack) { score2 += 1; slotReasons.push("Gets stronger <strong>with each attack performed</strong> — builds up power throughout the turn. More attacks = more stacks."); }

  // Support (Slot 3)
  if (hasSupport) { score3 += 4; slotReasons.push("Buffs allies' stats — <strong>float in slot 3</strong> so both rotations benefit from the support."); }
  if (hasKiSupport) { score3 += 2; slotReasons.push("Gives Ki to allies — helps the whole team reach their super attack threshold."); }
  if (hasDebuff) { score3 += 1; slotReasons.push("Lowers enemy ATK/DEF — weakens the enemy for your whole team."); }

  // Slot-conditional bonuses
  if (hasSlotConditional) {
    let slotCondTips = [];
    // Extract slot bonus text and check for "once" markers
    function extractSlotInfo(marker) {
      const idx = pOrig.toLowerCase().indexOf(marker);
      if (idx < 0) return { text: null, isOnce: false };
      const after = pOrig.substring(idx);
      const chunk = after.split(/(?=As the \d|When\s|For\s\d|Basic effect)/i)[0];
      const parts = chunk.split(/;\s*-?\s*/).slice(1).map(s => s.trim()).filter(Boolean);
      const text = parts.length > 0 ? parts.join("; ") : null;
      // Check for once markers in this section
      const lower = chunk.toLowerCase();
      const isOnce = lower.includes("once only") || lower.includes("once within");
      return { text, isOnce };
    }
    // Track which slots have once-only effects for strategy tips
    let onceSlots = [];
    let repeatSlots = [];
    if (hasSlot1Bonus) {
      const info = extractSlotInfo("as the 1st attacker");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slot 1 bonus</strong>${onceTag}: ${info.text || 'extra effects when attacking first'}`);
      if (info.isOnce) onceSlots.push("slot 1"); else repeatSlots.push("slot 1");
      score1 += 2;
    }
    if (hasSlot2Bonus) {
      const info = extractSlotInfo("as the 2nd attacker");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slot 2 bonus</strong>${onceTag}: ${info.text || 'extra effects in the middle slot'}`);
      if (info.isOnce) onceSlots.push("slot 2"); else repeatSlots.push("slot 2");
      score2 += 2;
    }
    if (hasSlot3Bonus) {
      const info = extractSlotInfo("as the 3rd attacker");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slot 3 bonus</strong>${onceTag}: ${info.text || 'extra effects in the last slot'}`);
      if (info.isOnce) onceSlots.push("slot 3"); else repeatSlots.push("slot 3");
      score3 += 2;
    }
    if (hasSlot1or2) {
      const info = extractSlotInfo("1st or 2nd");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slots 1 or 2 bonus</strong>${onceTag}: ${info.text || 'extra effects on main rotation'}`);
      score1 += 1; score2 += 1;
    }
    if (hasSlot1or3) {
      const info = extractSlotInfo("1st or 3rd");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slots 1 or 3 bonus</strong>${onceTag}: ${info.text || 'extra effects in these positions'}`);
      score1 += 1; score3 += 1;
    }
    if (hasSlot2or3) {
      const info = extractSlotInfo("2nd or 3rd");
      const onceTag = info.isOnce ? ' <span style="color:#FFD700;font-size:10px;font-weight:800">⚡ ONCE ONLY</span>' : ' <span style="color:#81C784;font-size:10px;font-weight:800">∞ EVERY TURN</span>';
      slotCondTips.push(`<strong>Slots 2 or 3 bonus</strong>${onceTag}: ${info.text || 'extra effects when not leading'}`);
      score2 += 1; score3 += 1;
    }
    slotReasons.push("This unit has <strong>slot-conditional passive effects</strong> — their power changes based on where you put them:");
    slotCondTips.forEach(t => slotReasons.push("&nbsp;&nbsp;" + t));
    slotReasons.push('<span style="color:#AAA;font-size:11px">Note: Some bonuses marked ∞ may actually be once-only (!1) in-game — check the passive text for "(once only)" or look for the yellow !1 icon in-game. Once-only bonuses can be <strong>saved for a key moment</strong> or used early.</span>');
    // Strategic note about once-only effects
    if (onceSlots.length > 0) {
      slotReasons.push(`<span style="color:#FFD700">⚡ IMPORTANT:</span> Some slot bonuses (${onceSlots.join(", ")}) are <strong>once only per battle</strong> — they only trigger the first time you use that slot. You can <strong>save them for a clutch moment</strong> or use them early for a strong start.`);
    }
  }

  if (isLR) score2 += 1;

  let slotName, slotExplain;
  if (hasSlotConditional) {
    // For slot-conditional units, give more nuanced advice
    const scores = [{name: "Slot 1", s: score1}, {name: "Slot 2", s: score2}, {name: "Slot 3", s: score3}];
    scores.sort((a,b) => b.s - a.s);
    slotName = scores[0].name + (scores[0].name === "Slot 1" ? " — Tank / Lead" : scores[0].name === "Slot 3" ? " — Floater / Support" : " — Main Rotation");
    slotExplain = `This unit gets <strong>different bonuses depending on slot position</strong>. Their best slot is usually ${scores[0].name}, but read the slot-conditional effects below — you may want to adjust positioning based on the situation.`;
  } else if (score1 >= score2 && score1 >= score3) {
    slotName = "Slot 1 — Tank / Lead";
    slotExplain = "This unit takes hits well. Put them in the first slot so they absorb attacks before your damage dealers.";
  } else if (score3 > score1 && score3 > score2) {
    slotName = "Slot 3 — Floater / Support";
    slotExplain = "This unit supports the team. Let them float (appear every other turn) so both of your main rotations get their buffs.";
  } else {
    slotName = "Slot 2 — Main Rotation";
    slotExplain = "This unit deals big damage. Keep them on the main rotation (slots 1 or 2) so they attack every turn.";
  }

  if (slotReasons.length === 0) {
    slotReasons.push("General-purpose unit — flexible in most slots depending on the team.");
  }

  // ========== TURN-BY-TURN STRATEGY ==========
  let turnStrategy = [];

  // Early turns (1-3)
  let earlyTips = [];
  if (hasDefStack) earlyTips.push("DEF stacking hasn't built up yet — <strong>avoid putting this unit in front of heavy hitters</strong> in the first few turns. They need time to stack.");
  if (hasDefTempBoost && !hasDefStack) earlyTips.push("DEF boost is <strong>temporary (1 turn only)</strong> — they get a DEF spike when they super, but it resets next turn. They won't get tankier over time like stackers do.");
  if (hasActive) earlyTips.push("Active skill <strong>won't be ready yet</strong> — focus on building up conditions to unlock it.");
  if (hasTransforms) earlyTips.push("Transformation conditions aren't met yet — <strong>play them in base form</strong> and work toward the turn/HP threshold.");
  if (hasGuard || (hasDmgReduction && drPercents.some(d => d >= 30))) earlyTips.push("Already tanky from turn 1 — safe to put in front of attacks right away.");
  if (hasEvade && maxEvade >= 30) earlyTips.push(`Up to ${maxEvade}% dodge (${baseEvade}% base + slot bonuses) works from turn 1 — <strong>evasion is active immediately</strong>, but remember it's RNG.`);
  if (hasPerAttack) earlyTips.push("Builds up power per attack — will start weaker but gets stronger throughout each turn as they attack more.");
  if (hasForesee) earlyTips.push("<strong>Scouter effect available</strong> — use it to rearrange your units and dodge enemy supers from the start.");
  if (hasRevive) earlyTips.push("Revive is available as a safety net — don't worry about taking risks early. If things go wrong, the revive will save you (once).");
  if (hasSurviveKO && hasEvade) earlyTips.push("<strong>Survive K.O. + dodge combo is active from turn 1</strong> — even if dodge fails, they survive the hit. Very safe to put in front of attacks.");
  if (isTagUnit) earlyTips.push("<strong>Tag unit — choose your starting form wisely.</strong> Start with the tanky form (guard/DR) if the boss hits hard early, or the dodge form if the boss cancels defense.");
  if (stacksAtkNotDef) earlyTips.push('<span style="color:#FF9800">⚠ No DEF stacking</span> — this unit does NOT get tankier over time. Be careful with them early AND late. They need protection from support or items.');
  if (hasRawDefOnly && isLR) earlyTips.push("No guard, DR, or dodge — <strong>rely purely on raw DEF</strong>. May need protection early against hard-hitting bosses.");
  if (earlyTips.length === 0) earlyTips.push("No special setup needed — use them normally from the start.");
  turnStrategy.push({ phase: "EARLY (Turns 1–3)", tips: earlyTips });

  // Mid (4-6)
  let midTips = [];
  if (hasDefStack) midTips.push("DEF stacks are building up — this unit is <strong>getting significantly tankier</strong> now. Safe to take more hits.");
  if (hasDefTempBoost && !hasDefStack) midTips.push("DEF boost still resets each turn — <strong>make sure they super every turn</strong>. If they don't super, they have no DEF boost.");
  if (hasActive) {
    if (activeCondition.includes("5") || activeCondition.includes("4")) {
      midTips.push("Active skill should be <strong>available around now</strong> — look for the button and use it at the right moment.");
    } else if (activeCondition.includes("hp") && activeCondition.includes("below")) {
      midTips.push("Active skill needs <strong>HP to drop below a threshold</strong> — may be ready depending on damage taken.");
    } else {
      midTips.push("Check if active skill conditions are met — they may be ready to use.");
    }
  }
  if (hasTransforms) midTips.push("Transformation may be <strong>available now</strong> depending on conditions — check the transformation tab.");
  if (hasSupport) midTips.push("Keep floating to maximize team buffs — both rotations benefit from the support.");
  if (hasEvade && maxEvade >= 30) midTips.push(`Still relying on up to ${maxEvade}% dodge — <strong>position in ${bestEvadeSlot} for max evasion</strong>. Dodge is great but not guaranteed.`);
  if (midTips.length === 0) midTips.push("Continue using them the same way. Consistent performance across turns.");
  turnStrategy.push({ phase: "MID (Turns 4–6)", tips: midTips });

  // Late (7+)
  let lateTips = [];
  if (hasDefStack) {
    lateTips.push("DEF is <strong>fully stacked</strong> — this unit is now one of your best tanks. Permanent DEF is massive by now.");
    if (!hasDmgReduction && !hasGuard) lateTips.push('<span style="color:#FF9800">⚠ But beware DEF-ignore phases</span> — some late boss phases (Jiren Phase 2, newer Red Zones) ignore your DEF entirely. All that stacking becomes meaningless. If the boss ignores DEF, you need DR/guard allies to survive.');
  }
  if (hasGreatlyDefStack) lateTips.push("\"Greatly raises DEF\" stacks are <strong>huge</strong> — excellent in most content. But even massive stacked DEF won't save you against bosses that ignore defense.");
  if (hasDefTempBoost && !hasDefStack) lateTips.push("DEF boost is still temporary — they're <strong>no tankier now than on turn 1</strong>. Not ideal for long events.");
  if (stacksAtkNotDef) lateTips.push('<span style="color:#FF9800">⚠ ATK is high but DEF hasn\'t improved</span> — they hit hard by now but are just as fragile as turn 1. Bosses hit hardest in late phases, so <strong>protect this unit with support or items</strong>.');
  if (hasActive && !activeCondition.includes("once")) lateTips.push("If active skill is unused, now is a good time — bosses hit hardest in later phases.");
  if (hasTransforms) lateTips.push("Should be in <strong>transformed state by now</strong> with upgraded stats and skills.");
  if (bigBadBosses) lateTips.push("<strong>Big Bad Bosses</strong> link activates below 80% HP — this unit gets stronger as HP drops in long fights.");
  if (hasEvade && maxEvade >= 30) lateTips.push(`Dodge is still their main defense — up to ${maxEvade}% evasion in ${bestEvadeSlot} can save a run or lose it. <strong>Have a backup plan</strong> in case dodge fails.`);
  if (hasRevive) lateTips.push("If revive hasn't been used yet, it's your <strong>emergency button</strong> — can save a run in the final phase.");
  if (lateTips.length === 0) lateTips.push("Performs consistently — no major changes needed in late turns.");
  turnStrategy.push({ phase: "LATE (Turns 7+)", tips: lateTips });

  // ========== DEFENSIVE TIPS ==========
  let defTips = [];
  if (hasGuard) {
    defTips.push("Guards all attacks — <strong>type disadvantage doesn't matter</strong>. Can tank any enemy type safely.");
    if (!hasDmgReduction) defTips.push('<span style="color:#FF9800">Note:</span> Guard alone without DR may not be enough for the hardest bosses. Modern Red Zone/Tamagami supers hit for 1M+ — guard helps but you still take massive damage without DR on top of it.');
  }
  if (hasDmgReduction) {
    const hasDRVariation = totalDR.slot1 !== totalDR.slot2 || totalDR.slot1 !== totalDR.slot3;
    if (maxDR >= 60) {
      defTips.push(`<strong>Up to ${maxDR}% total damage reduction</strong>${hasDRVariation ? ` (${baseDR}% base, up to ${maxDR}% with slot bonuses)` : ""} — elite-level tanking. Even modern bosses hitting for 1M+ deal manageable damage. This is the gold standard for hard content.`);
    } else if (maxDR >= 40) {
      defTips.push(`<strong>Up to ${maxDR}% total damage reduction</strong>${hasDRVariation ? ` (${baseDR}% base, up to ${maxDR}% with slot bonuses)` : ""} — very strong, but modern bosses hit so hard that even with ${maxDR}% DR, supers from Red Zone/Tamagami bosses can still deal 400-600K+. Pair with guard or high DEF for best results.`);
    } else if (maxDR > 0) {
      defTips.push(`<strong>${maxDR}% damage reduction</strong>${hasDRVariation ? ` (${baseDR}% base + conditional bonuses)` : ""} — helps but ${maxDR}% is on the lower end for current hard content. Modern bosses super for 1M+ — at ${maxDR}% DR you're still taking ${Math.round((100-maxDR)/100 * 800)}K+ from those supers.`);
    } else {
      defTips.push("Has damage reduction — takes less damage from all attacks.");
    }
  }
  if (hasEvade) {
    const hasEvadeVariation = totalEvade.slot1 !== totalEvade.slot2 || totalEvade.slot1 !== totalEvade.slot3;
    const evadeBreakdown = hasEvadeVariation ? ` Slot 1: ${totalEvade.slot1}% | Slot 2: ${totalEvade.slot2}% | Slot 3: ${totalEvade.slot3}%.` : "";
    if (maxEvade >= 60) {
      defTips.push(`<strong>Up to ${maxEvade}% evasion (${baseEvade}% base + slot bonuses stack additively) — dodging is this unit's primary defense.</strong> When they dodge, zero damage. In the right slot they're nearly untouchable.${evadeBreakdown}`);
    } else if (maxEvade >= 40) {
      defTips.push(`<strong>Up to ${maxEvade}% evasion${baseCrit !== maxEvade ? ` (${baseEvade}% base + conditional bonuses that add on top)` : ""} — dodging is a key part of their defense.</strong> When they dodge, zero damage taken. Strong but still RNG.${evadeBreakdown}`);
    } else if (maxEvade >= 25) {
      defTips.push(`<strong>${maxEvade}% evasion chance</strong>${hasEvadeVariation ? ` (varies by slot: ${evadeBreakdown})` : ""} — good odds of dodging. Helps avoid big damage but it's still RNG.`);
    } else if (maxEvade > 0) {
      defTips.push(`Has ${maxEvade}% evasion — occasional dodges. Nice bonus but not their main defense.`);
    } else {
      defTips.push("Has evasion — can dodge attacks. Chance-based, helpful but not reliable.");
    }
  }
  if (hasNullify) defTips.push("<strong>Can nullify enemy super attacks</strong> — completely blocks the enemy's strongest move. One of the rarest and most valuable defensive mechanics in the game.");
  if (hasRevive && !hasSurviveKO) defTips.push("<strong>Revive mechanic</strong> — survives a K.O. hit and recovers HP (once per battle). Acts as an insurance policy against one-shot attacks.");
  if (hasSurviveKO) {
    defTips.push("<strong>Survives K.O. attacks within the turn</strong> — even when hit by a lethal attack, they stay alive. This is especially powerful on dodge characters — when dodge fails, they still survive.");
    if (hasEvade && maxEvade >= 30) defTips.push('<span style="color:#81C784">★ The dodge + survive K.O. combo makes this unit incredibly reliable.</span> Most dodge units eventually get hit, but with survive K.O., one failed dodge doesn\'t end the run. This has won countless runs in hard content.');
  }
  if (hasForesee) defTips.push("<strong>Scouter effect (foresee super attacks)</strong> — reveals which slot the enemy will super in. This lets you move your tankiest unit to block it or move a fragile unit away. Incredibly valuable in hard content.");
  if (hasDefStack) {
    if (hasGreatlyDefStack) {
      defTips.push("Super attack <strong>greatly raises DEF permanently</strong> (stacks infinitely) — one of the best stacking units. Gets nearly unkillable in long events.");
    } else {
      defTips.push("Super attack <strong>raises DEF permanently</strong> (stacks infinitely) — solid stacker, steadily gets tankier every turn.");
    }
    if (!hasDmgReduction && !hasGuard) {
      defTips.push('<span style="color:#FF9800">⚠ DEF stacking alone has limits in modern content:</span> Bosses like Jiren (Phase 2) <strong>ignore 100% of your DEF</strong>, making all stacking useless in that fight. Red Zone bosses that ignore 50-80% DEF also drastically reduce the value of stacking. Without DR or guard as backup, pure DEF stackers become vulnerable in the hardest phases.');
    }
  }
  if (hasDefTempBoost && !hasDefStack) {
    if (saDefInfo.greatlyTempBoost || usaDefInfo.greatlyTempBoost) {
      defTips.push("Super attack <strong>greatly raises DEF for 1 turn</strong> — big DEF spike when they super, but it <strong>resets next turn</strong>. Does NOT permanently stack.");
    } else {
      defTips.push("Super attack <strong>raises DEF for 1 turn</strong> — moderate boost when they super, but it <strong>resets next turn</strong>. Does NOT permanently stack.");
    }
  }
  if (hasGuardAndDR) {
    if (maxDR >= 60) {
      defTips.push('<span style="color:#81C784">★ Guard + ' + maxDR + '% Damage Reduction</span> — elite defensive combo. This unit can tank almost anything in the game including modern Red Zone supers and Tamagami bosses. One of the safest units to put in slot 1 against any content.');
    } else {
      defTips.push('<span style="color:#81C784">★ Guard + Damage Reduction combo</span> — very tanky setup. Guard removes type disadvantage and DR reduces raw damage. However, at ' + maxDR + '% DR, the absolute hardest bosses (Tamagami, Jiren) can still deal significant damage through supers. Still one of the tankiest combos available.');
    }
  }
  if (hasHealing) {
    if (hasEndOfTurnHeal) defTips.push("<strong>Heals at end of every turn</strong> — incredible sustain. Great for bomb stages and long events. Keeps the team healthy without using items.");
    else defTips.push("Has HP recovery — helps sustain through longer fights without using items.");
  }
  if (hasSeal) defTips.push("Can <strong>seal enemy super attacks</strong> — prevents the enemy from supering next turn. Huge for survival.");
  if (hasStun) defTips.push("Can <strong>stun enemies</strong> — stops the enemy from attacking for one turn. Very useful but bosses often resist.");
  if (hasDisableAction) defTips.push("<strong>Can disable enemy actions</strong> — prevents an enemy from attacking that turn. Extremely powerful crowd control.");
  if (hasDodgeCancelVulnerability) defTips.push('<span style="color:#FF9800">⚠ Dodge-cancel vulnerability:</span> This unit\'s primary defense is dodge. Against bosses that cancel dodge (like some Red Zone and Tamagami bosses), <strong>they lose their main defense</strong>. In those fights, consider using a different unit or pairing with guard/DR support.');
  if (hasRawDefOnly && isLR) defTips.push('<span style="color:#FF9800">⚠ Raw DEF only:</span> No dodge, guard, or damage reduction. Against endgame bosses hitting for 10M+ or ignoring defense, raw DEF alone may not be enough. Needs team support to survive.');
  if (isTagUnit) defTips.push('<strong>Tag unit flexibility:</strong> Can switch between forms to adapt to the fight. Use the DR/guard form against normal bosses, and switch to the dodge form against bosses that ignore 100% defense. This counterplay is extremely valuable.');
  // Multi-layered defense assessment
  const defLayers = [hasGuard, hasDmgReduction && maxDR >= 30, hasEvade && maxEvade >= 30, hasDefStack, hasSurviveKO || hasRevive, hasNullify].filter(Boolean).length;
  if (defLayers >= 3) {
    defTips.push('<span style="color:#81C784">★ Multi-layered defense (' + defLayers + ' layers)</span> — modern hard content requires multiple defensive mechanics because bosses can cancel dodge, ignore DEF, or pierce DR. This unit has answers for multiple boss mechanics, making them viable across all content types.');
  } else if (defLayers === 0 && isLR) {
    defTips.push('<span style="color:#FF9800">⚠ No defensive layers</span> — modern Red Zone bosses super for 800K-1.2M, Tamagami bosses attack 5-8 times per turn, and some bosses ignore DEF entirely. Without dodge, guard, DR, or revive, this unit is a major liability in hard content. Keep them protected or use in easier events.');
  }
  if (defTips.length === 0) {
    defTips.push("No standout defensive abilities — <strong>avoid putting this unit in slot 1</strong> against strong enemies. Modern bosses hit for 800K-1M+ on supers and attack multiple times per turn.");
  }

  // ========== WHERE TO USE (CONTENT) ==========
  let contentAdvice = [];
  if (hasDefStack) {
    contentAdvice.push("<strong>Long events (LVE, LGTE, Fighting Legend)</strong> — permanent DEF stacking makes them better every turn. Top pick for endurance fights.");
    if (!hasDmgReduction && !hasGuard) contentAdvice.push('<span style="color:#FF9800">⚠ Struggles vs DEF-ignore bosses</span> — Jiren Phase 2 ignores 100% DEF, some Red Zone bosses ignore 50-80%. Pure DEF stackers become paper in those fights. Need DR or guard partners to cover these phases.');
  }
  if (hasDefTempBoost && !hasDefStack) contentAdvice.push("<strong>Short/medium events only</strong> — DEF boost is for 1 turn and does NOT stack. In long events or multi-phase fights, this unit doesn't get any tankier. Against modern bosses supering for 1M+, a temporary DEF raise often isn't enough.");
  if (hasGuard || (hasDmgReduction && drPercents.some(d => d >= 30))) {
    contentAdvice.push("<strong>Red Zone / Cell Max</strong> — tanking lets them survive big attacks. But be aware: modern Red Zone supers hit for 800K-1.2M, and Cell Max AoE hits all 3 slots for 1M+. Even with guard/DR, positioning matters.");
  }
  if (hasGuardAndDR) {
    contentAdvice.push("<strong>Tamagami / Supreme Magnificent Battle</strong> — guard + DR is the best defensive setup for the hardest content. But even this combo gets tested by Tamagami's multi-attack patterns (5-8 attacks per turn) and bomb orb mechanics.");
  }
  if (hasEvade && maxEvade >= 30) {
    contentAdvice.push(`<strong>Any content where dodging matters</strong> — ${maxEvade}% evasion is strong everywhere. Especially good in SBR where dodging even one super can save a run.`);
    if (hasDodgeCancelVulnerability) contentAdvice.push('<span style="color:#FF9800">⚠ Avoid dodge-cancel stages</span> — some bosses (Jiren phase 1, certain Red Zones) cancel dodge entirely. This unit loses their main defense in those fights.');
  }
  if (hasDodgeAndSurviveKO) contentAdvice.push("<strong>Bomb stages & survival content</strong> — dodge + survive K.O. is perfect for stages with instant-kill mechanics. Even when dodge fails, they live.");
  if (hasEndOfTurnHeal) contentAdvice.push("<strong>Bomb stages</strong> — end-of-turn healing is invaluable for bomb mechanics. Consistent healing keeps you above lethal thresholds.");
  if (hasSupport) contentAdvice.push("<strong>Everywhere</strong> — support units fit on any team. Great in Battlefield and Chain Battle too.");
  if (hasStun || hasSeal) contentAdvice.push("<strong>Super Battle Road (SBR/ESBR)</strong> — stunning and sealing multiple enemies is key to surviving.");
  if (hasCounter) contentAdvice.push("<strong>SBR/ESBR</strong> — counters are insane in multi-enemy stages. Each counter is free damage.");
  if (hasForesee) contentAdvice.push("<strong>All hard content</strong> — scouter effect is universally useful. Knowing where the enemy super is coming lets you optimize your rotation every turn.");
  if (hasNullify) contentAdvice.push("<strong>Red Zone / Hard boss fights</strong> — nullifying enemy supers removes the most dangerous attacks entirely.");
  if (hasRevive) contentAdvice.push("<strong>Any difficult content</strong> — revive acts as a free retry. Essential for no-item runs and first attempts at hard stages.");
  if (hasHealing && !hasEndOfTurnHeal) contentAdvice.push("<strong>Long events & difficult content</strong> — healing sustains your team without wasting items.");
  if (isTagUnit) contentAdvice.push("<strong>Versatile across all content</strong> — tag units can adapt to different boss mechanics by switching forms. Use the tanky form early and dodge form when the boss ignores defense.");
  if (hasAdditional || hasCrit || hasTypeEff) contentAdvice.push("<strong>Dokkan Events & EZA Battles</strong> — raw damage output clears shorter events quickly.");
  if (stacksAtkNotDef) contentAdvice.push('<span style="color:#FF9800">⚠ Weaker in long events</span> — stacks ATK but not DEF, so they don\'t get tankier over time. In very long fights, they can become a liability defensively.');
  if (hasRawDefOnly && isLR) contentAdvice.push('<span style="color:#FF9800">⚠ Struggles against defense-ignoring bosses</span> — with only raw DEF and no dodge/guard/DR, bosses that ignore defense will destroy this unit.');
  if (isLR) contentAdvice.push("<strong>Any hard content</strong> — as an LR, their raw stats make them viable almost everywhere.");
  if (needsSuperAllies) contentAdvice.push('<span style="color:#FF9800">⚠ Limited on villain-heavy teams</span> — needs Super Class allies for full power. As more strong villains enter the meta, finding optimal teams becomes harder. Works best on pure hero teams.');
  if (contentAdvice.length === 0) contentAdvice.push("<strong>General content</strong> — works well in most events. May struggle in the hardest endgame content without support.");

  // ========== ORB ANALYSIS ==========
  let orbAdvice = [];
  const orbColor = { AGL: "Blue", TEQ: "Green", INT: "Purple", STR: "Red", PHY: "Orange" };
  const color = orbColor[unitType] || unitType;

  const kiSphereMatch = p.match(/per (?:(\w+) )?ki sphere/i);
  const rainbowOrb = p.includes("rainbow") && p.includes("ki sphere");
  const specificOrbMatch = p.match(/per (agl|teq|int|str|phy) ki sphere/i);
  const orbCountMatch = p.match(/with (\d+) or more ki spheres? obtained/i);
  const kiPerSphere = p.includes("ki +") && p.includes("per") && p.includes("ki sphere");

  if (specificOrbMatch) {
    const orbType = specificOrbMatch[1].toUpperCase();
    const orbC = orbColor[orbType] || orbType;
    orbAdvice.push(`Powers up <strong>per ${orbC} (${orbType}) Ki Sphere</strong>. Prioritize ${orbC} orbs to maximize damage.`);
    orbAdvice.push(`Pair with orb changers that create ${orbC} orbs for the biggest boost.`);
  } else if (kiSphereMatch) {
    orbAdvice.push(`Powers up <strong>per Ki Sphere</strong> (any color). Grab as many orbs as possible — their passive scales with orb count.`);
  }
  if (kiPerSphere) {
    orbAdvice.push(`Gets <strong>extra Ki per Ki Sphere</strong> — easier to reach max Ki. Great for hitting 18 Ki on LRs or guaranteeing supers.`);
  }
  if (rainbowOrb) {
    orbAdvice.push(`Benefits from <strong>Rainbow Ki Spheres</strong>. Use items or support units that create rainbow orbs.`);
  }
  if (hasOrbChange) {
    orbAdvice.push(`<strong>Changes Ki Sphere types</strong> — creates orbs for themselves and teammates. Very useful for orb-hungry allies.`);
  }
  if (orbCountMatch) {
    const count = parseInt(orbCountMatch[1]);
    orbAdvice.push(`Needs <strong>${count}+ Ki Spheres</strong> to fully activate passive. Use orb changers if they can't reach ${count} on their own.`);
    if (count >= 5) orbAdvice.push(`<span style="color:#FF9800">⚠ Orb hungry</span> — needs ${count}+ orbs which is a lot. Without orb changers, bad orb RNG can cripple this unit. <strong>Pair with rainbow orb changers</strong> like Future Gohan & Trunks or units that change type orbs to rainbow.`);
  }
  if (isLR) {
    orbAdvice.push(`As an LR, they have <strong>two super attack tiers</strong>:`);
    orbAdvice.push(`&nbsp;&nbsp;• 12 Ki = Regular Super (weaker)`);
    orbAdvice.push(`&nbsp;&nbsp;• 18 Ki = Ultra Super (full power)`);
    orbAdvice.push(`Always aim for <strong>18 Ki</strong>. That means ~6 ${color} orbs plus Ki from links. Use Ki supports if they struggle to reach 18.`);
  } else {
    orbAdvice.push(`Needs <strong>12 Ki to super attack</strong>. Their orb color is ${color} (${unitType}). Usually 4-5 matching orbs + link Ki is enough.`);
  }

  // ========== PARTNER / CATEGORY ANALYSIS ==========
  let partnerAdvice = [];
  let categoryNeeds = [];

  const nameMatches = p.matchAll(/(?:whose |an? |the )name includes "([^"]+)"/gi);
  for (const m of nameMatches) {
    partnerAdvice.push(`Wants an ally whose name includes <strong>"${m[1]}"</strong> — check the passive for what bonus this triggers.`);
  }

  const catConditions = [
    ...p.matchAll(/"([^"]+)" category (?:allies?|characters?|members?)/gi),
    ...p.matchAll(/(?:with|when|if) (?:\d+ or more )?"([^"]+)" category/gi),
  ];
  const seenCats = new Set();
  for (const m of catConditions) {
    const cat = m[1];
    if (!seenCats.has(cat.toLowerCase())) { seenCats.add(cat.toLowerCase()); categoryNeeds.push(cat); }
  }

  if (needsSuperAllies) {
    partnerAdvice.push(`Needs <strong>Super Class allies</strong> for full power. Run a full hero team for max effect.`);
    partnerAdvice.push(`<span style="color:#FF9800">⚠ Negative synergy with villains</span> — even if villain units share categories, they don't count as Super Class allies. This limits team building as more strong villains enter the meta.`);
  }
  if (needsExtremeAllies) {
    partnerAdvice.push(`Needs <strong>Extreme Class allies</strong> for full power. Run a full villain team for max effect.`);
    partnerAdvice.push(`<span style="color:#FF9800">⚠ Negative synergy with heroes</span> — even if hero units share categories, they don't count as Extreme Class allies.`);
  }

  const allyCountMatch = p.match(/(\d+) or more "([^"]+)" category (?:allies|characters)/i);
  if (allyCountMatch) {
    partnerAdvice.push(`Needs <strong>${allyCountMatch[1]}+ "${allyCountMatch[2]}" category allies</strong> to fully activate passive.`);
  }

  // Per-ally scaling
  const perAllyMatch = p.match(/per "([^"]+)" category ally/i);
  if (perAllyMatch) {
    partnerAdvice.push(`Scales per <strong>"${perAllyMatch[1]}" category ally</strong> on the team — the more allies from this category, the stronger they get.`);
  }

  // Allies attacking in same turn
  const sameRotMatch = p.match(/"([^"]+)" category ally attacking in the same turn/i);
  if (sameRotMatch) {
    partnerAdvice.push(`Gets bonuses per <strong>"${sameRotMatch[1]}" category ally on rotation</strong> — keep allies from this category on the same rotation.`);
  }

  if (p.includes("same name")) {
    partnerAdvice.push(`Has <strong>same name</strong> conditions — check if they need or restrict same-name allies.`);
  }

  const leaderCats = [...leader.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  if (leaderCats.length > 0) {
    partnerAdvice.push(`Leader skill boosts: <strong>${leaderCats.join(", ")}</strong>. Fill your team from these categories.`);
  }

  const keyLinks = (raw.links || []).filter(l =>
    ["Prepared for Battle", "Over in a Flash", "Shocking Speed", "Fierce Battle",
     "Big Bad Bosses", "Tournament of Power", "Kamehameha", "The Saiyan Lineage",
     "Super Saiyan", "Fused Fighter", "Legendary Power", "Shattering the Limit"
    ].includes(l)
  );
  if (keyLinks.length > 0) {
    partnerAdvice.push(`Key links: <strong>${keyLinks.join(", ")}</strong>. Pair with units sharing these for Ki + ATK/DEF boosts.`);
  }

  if (categoryNeeds.length > 0) {
    partnerAdvice.push(`Passive references: <strong>${categoryNeeds.join(", ")}</strong>. Allies from these categories unlock extra buffs.`);
  }

  if (partnerAdvice.length === 0) {
    partnerAdvice.push("No specific ally conditions. Focus on shared link skills and categories for best synergy.");
  }

  // ========== TRANSFORMATION / ACTIVE SKILL TIMING ==========
  let transformTips = [];
  if (hasTransforms) {
    transformTips.push("This unit <strong>transforms</strong> when conditions are met (turn count, HP, etc.). Check the transformation tabs for details.");
    if (p.includes("turn") || activeCondition.includes("turn")) {
      const turnMatch = (p + " " + activeCondition).match(/(\d+)\s*(?:th|st|nd|rd)?\s*turn/);
      if (turnMatch) transformTips.push(`Triggers around <strong>turn ${turnMatch[1]}</strong> — keep them alive until then.`);
    }
    transformTips.push("In short events they may never transform — that's OK. Transformations shine in <strong>longer content</strong>.");
  }
  if (hasActive) {
    transformTips.push("Has an <strong>Active Skill</strong> — a one-time ability you manually trigger when conditions are met.");
    if (activeCondition.includes("hp") && activeCondition.includes("below")) {
      transformTips.push("Needs <strong>low HP</strong> to activate — don't panic when HP drops, it's enabling this unit.");
    }
    if (activeCondition.includes("enemy")) {
      transformTips.push("Has an <strong>enemy-related condition</strong> — may only work against certain opponents or phases.");
    }
    transformTips.push("Save it for when you need it most — usually a tough boss phase or when you need burst damage/defense.");
  }

  // ========== LEADER SKILL CHECK ==========
  const kiMatchL = leader.match(/ki \+(\d)/);
  const statMatchL = leader.match(/hp.*atk.*def.*\+(\d+)%/);
  let isGoodLeader = false;
  let leaderTip = "";
  if (kiMatchL && parseInt(kiMatchL[1]) >= 3 && statMatchL && parseInt(statMatchL[1]) >= 130) {
    isGoodLeader = true;
    leaderTip = `Strong leader skill — <strong>Ki +${kiMatchL[1]} and ${statMatchL[1]}% stats</strong>. Great pick as your team leader.`;
  }

  // ========== QUICK TIPS ==========
  let quickTips = [];
  // Stacking info
  if (hasDefStack && hasAtkStack) quickTips.push("Super <strong>permanently stacks ATK and DEF</strong> — gets stronger AND tankier every turn. Amazing in long events.");
  else if (hasDefStack) {
    quickTips.push("Super <strong>permanently stacks DEF</strong> — gets tankier every turn. Prioritize supering every turn.");
    if (stacksDefNotAtk) quickTips.push('<span style="color:#FF9800">⚠ Stacks DEF but NOT ATK</span> — great tank, but damage won\'t scale with turns. This is a known limitation that keeps some stackers from being top tier.');
  }
  else if (hasAtkStack) {
    quickTips.push("Super <strong>permanently stacks ATK</strong> — hits harder every turn. Great for long fights.");
    if (stacksAtkNotDef) quickTips.push('<span style="color:#FF9800">⚠ Stacks ATK but NOT DEF</span> — damage scales up but defense stays the same. <strong>Be careful in early turns</strong> — they need protection until the fight is won. They won\'t get tankier over time.');
  }
  if (hasDefTempBoost && !hasDefStack) quickTips.push("DEF raise is <strong>for 1 turn only — does NOT stack</strong>. Resets each turn, must super every turn to stay safe.");
  if (hasAtkTempBoost && !hasAtkStack) quickTips.push("ATK raise is <strong>for 1 turn only — does NOT stack</strong>. Temporary spike on the turn they super.");
  // Key offensive
  if (hasCrit && maxCrit >= 30) quickTips.push(`Up to <strong>${maxCrit}% crit chance</strong>${baseCrit !== maxCrit ? ` (${baseCrit}% base + slot bonuses)` : ""} — frequently deals massive damage that ignores type.`);
  if (hasTypeEff) quickTips.push("<strong>Type effective against all</strong> — always deals boosted damage regardless of enemy type.");
  if (hasAdditional) quickTips.push("Launches <strong>additional attacks</strong> — more damage and extra chances to proc super attack effects.");
  // Key defensive
  if (hasEvade && maxEvade >= 30) quickTips.push(`<strong>Up to ${maxEvade}% dodge</strong>${baseEvade !== maxEvade ? ` (${baseEvade}% base + slot bonuses stack)` : ""} — evasion is a core part of their kit. Best in ${bestEvadeSlot}.`);
  if (hasGuard) quickTips.push("<strong>Guards all attacks</strong> — type disadvantage means nothing to this unit.");
  if (hasNullify) quickTips.push("<strong>Can nullify enemy super attacks</strong> — one of the rarest abilities. Completely blocks supers.");
  if (hasRevive) quickTips.push("<strong>Has a revive</strong> — survives a K.O. once per battle. Your safety net.");
  if (hasForesee) quickTips.push("<strong>Scouter effect</strong> — reveals enemy super attack position. Rearrange your units to dodge it.");
  // Misc
  if (bigBadBosses) quickTips.push("Big Bad Bosses link activates below 80% HP — strongest in long fights where HP drops.");
  if (hasCounter) quickTips.push("Put this unit where attacks are coming in — each counter is free damage.");
  if (hasSupport && hasDefStack) quickTips.push("Rare combo: support + DEF stacking. Buffs the team AND gets tanky.");
  if (hasOrbChange) quickTips.push("<strong>Orb changer</strong> — creates Ki Spheres for themselves and the team. Pairs great with orb-hungry units.");
  if (hasDisableAction) quickTips.push("<strong>Can disable enemy actions</strong> — one of the strongest crowd control abilities.");
  // Elite combos
  if (hasDodgeAndSurviveKO) quickTips.push('<span style="color:#81C784">★ ELITE COMBO: Dodge + Survive K.O.</span> — even when dodge fails, they survive the hit. This is one of the strongest defensive combos in the game. Dodge characters with survive K.O. are incredibly consistent and can carry runs.');
  if (hasGuardAndDR) quickTips.push('<span style="color:#81C784">★ ELITE COMBO: Guard + Damage Reduction</span> — guards all types AND reduces damage. One of the tankiest possible combinations. Nearly unkillable.');
  if (hasGuard && hasEvade && maxEvade >= 30) quickTips.push('<span style="color:#81C784">★ ELITE COMBO: Guard + Dodge</span> — when dodge fails, guard catches them. Best of both worlds.');
  // Tag/Exchange/Standby
  if (isTagUnit) quickTips.push('<strong>Tag unit</strong> — can switch between characters. This gives you <strong>counterplay against different boss mechanics</strong>. Switch to the dodge character against defense-ignoring bosses, or the DR/guard character against dodge-cancelling bosses.');
  if (isExchangeUnit) quickTips.push('<strong>Exchange unit</strong> — swaps to a different character when conditions are met. Plan around the exchange condition — the new form often has a completely different kit.');
  if (isStandbyUnit) quickTips.push('<strong>Standby unit</strong> — activates standby skill when conditions are met (usually when K.O.\'d). The standby form is often much stronger.');
  // Vulnerability warnings
  if (hasDodgeCancelVulnerability) quickTips.push('<span style="color:#FF9800">⚠ DODGE CANCEL WARNING:</span> This unit relies heavily on dodge with no guard or DR as backup. Against bosses that cancel dodge, they become very vulnerable. <strong>Have a backup plan</strong> for dodge-cancel stages.');
  if (hasRawDefOnly && isLR) quickTips.push('<span style="color:#FF9800">⚠ Raw DEF only</span> — no dodge, guard, or damage reduction. Just raw DEF stat. Against endgame bosses that hit for 15M+, raw DEF alone is not enough. Needs support and careful positioning.');
  // Healing types
  if (hasEndOfTurnHeal) quickTips.push('<strong>Heals every turn (end of turn)</strong> — extremely valuable for sustain. Great for bomb stages and long events where consistent healing keeps you alive without items.');
  else if (hasHealing && p.includes("once")) quickTips.push('Has a <strong>one-time heal</strong> — use it as an emergency button when HP is critical.');
  else if (hasHealing) quickTips.push('Has HP recovery — helps sustain through longer fights.');
  // Team restriction warnings
  if (needsSuperAllies) quickTips.push('<span style="color:#FF9800">⚠ Needs Super Class allies</span> — restricted to hero teams. Has <strong>negative synergy with villain characters</strong> even if they share categories. As more strong villains enter the meta, this limits team building options.');
  if (needsExtremeAllies) quickTips.push('<span style="color:#FF9800">⚠ Needs Extreme Class allies</span> — restricted to villain teams. Can\'t run with most hero units even if they share categories.');
  // Once-only effects
  if (hasOnceEffects) quickTips.push("<span style='color:#FFD700'>⚡ Has once-only effects</span> — some parts of the passive only activate <strong>once per battle</strong>. Save them for when you need them most, or use early for a strong opening.");
  // Stacking caps
  if (hasStackCap) {
    const capMatches = [...pOrig.matchAll(/(\d+)%\s*\(up to\s+(\d+)%\)/gi)];
    if (capMatches.length > 0) {
      const cap = capMatches[0];
      quickTips.push(`Has <strong>stacking buffs with a cap</strong> (e.g. ${cap[1]}% per trigger, up to ${cap[2]}%) — builds up over multiple turns/attacks but hits a maximum. Plan around needing several turns to reach full power.`);
    }
  }

  return {
    slot: slotName,
    slotExplain,
    slotReasons,
    orbAdvice,
    partnerAdvice,
    isGoodLeader,
    leaderTip,
    leaderCats,
    turnStrategy,
    defTips,
    contentAdvice,
    transformTips,
    quickTips,
  };
}

// ---- Blend community gameplay knowledge into guide ----
function blendCommunityInsights(guide, unitId) {
  if (typeof EMBEDDED_REDDIT === "undefined") return guide;
  const ci = (EMBEDDED_REDDIT.unitInsights || {})[unitId];
  if (!ci) return guide;

  // Defense insights → defTips
  if (ci.defense && ci.defense.length > 0) {
    for (const tip of ci.defense) {
      guide.defTips.push(`<strong style="color:#64B5F6">[Community]</strong> ${tip}`);
    }
  }

  // Slot/rotation insights → slotReasons
  if (ci.slot && ci.slot.length > 0) {
    for (const tip of ci.slot) {
      guide.slotReasons.push(`<strong style="color:#64B5F6">[Community]</strong> ${tip}`);
    }
  }

  // Partner insights → partnerAdvice
  if (ci.partners && ci.partners.length > 0) {
    for (const tip of ci.partners) {
      guide.partnerAdvice.push(`<strong style="color:#64B5F6">[Community]</strong> ${tip}`);
    }
  }

  // Event performance insights → contentAdvice
  if (ci.events && ci.events.length > 0) {
    for (const tip of ci.events) {
      guide.contentAdvice.push(`<strong style="color:#64B5F6">[Community]</strong> ${tip}`);
    }
  }

  // Offense insights → quickTips (they're short and punchy)
  if (ci.offense && ci.offense.length > 0) {
    for (const tip of ci.offense.slice(0, 2)) {
      guide.quickTips.push(`<span style="color:#64B5F6">&#128172;</span> ${tip}`);
    }
  }

  // Build recommendations → quickTips
  if (ci.build && ci.build.length > 0) {
    for (const tip of ci.build.slice(0, 2)) {
      guide.quickTips.push(`<span style="color:#64B5F6">&#128172;</span> ${tip}`);
    }
  }

  // General gameplay observations → quickTips
  if (ci.general && ci.general.length > 0) {
    for (const tip of ci.general.slice(0, 1)) {
      guide.quickTips.push(`<span style="color:#64B5F6">&#128172;</span> ${tip}`);
    }
  }

  return guide;
}

// ---- DOM references ----
const listView = document.getElementById("listView");
const detailView = document.getElementById("detailView");
const unitListEl = document.getElementById("unitList");
const detailContent = document.getElementById("detailContent");
const searchInput = document.getElementById("searchInput");
const backBtn = document.getElementById("backBtn");
const paginationEl = document.getElementById("pagination");

// ---- Build category dropdown ----
function buildCategoryDropdown() {
  const catSet = new Set();
  allUnits.forEach(u => u.categories.forEach(c => catSet.add(c)));
  const sorted = [...catSet].sort();
  const select = document.getElementById("categoryFilter");
  sorted.forEach(cat => {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    select.appendChild(opt);
  });
}

// ---- Filtering ----
function getFiltered() {
  const q = searchInput.value.toLowerCase();
  return allUnits.filter(u => {
    // Text search
    const matchesSearch = !q ||
      u.name.toLowerCase().includes(q) ||
      u.title.toLowerCase().includes(q) ||
      u.type.toLowerCase().includes(q) ||
      u.categories.some(c => c.toLowerCase().includes(q)) ||
      u.links.some(l => l.toLowerCase().includes(q));

    // Type filter
    const matchesType = !filters.type || u.type === filters.type;

    // Rarity filter
    const matchesRarity = !filters.rarity || u.rarity === filters.rarity;

    // Class filter
    const matchesClass = !filters.class || u.class === filters.class;

    // Category filter
    const matchesCat = !filters.category || u.categories.includes(filters.category);

    return matchesSearch && matchesType && matchesRarity && matchesClass && matchesCat;
  });
}

// ---- Render active filter tags ----
function renderActiveFilters() {
  const container = document.getElementById("activeFilters");
  const active = Object.entries(filters).filter(([k, v]) => v !== null);

  if (active.length === 0) {
    container.innerHTML = "";
    return;
  }

  const labels = { type: "Type", rarity: "Rarity", class: "Class", category: "Category" };
  container.innerHTML = active.map(([key, val]) =>
    `<span class="active-filter-tag">${labels[key]}: ${val} <span class="clear-filter" onclick="clearFilter('${key}')">&times;</span></span>`
  ).join("") + `<button class="clear-all-btn" onclick="clearAllFilters()">Clear all</button>`;
}

function clearFilter(key) {
  filters[key] = null;
  currentPage = 1;
  // Reset button styles for that group
  document.querySelectorAll(`.filter-btn[data-group="${key}"]`).forEach(btn => {
    btn.className = "filter-btn";
  });
  if (key === "category") document.getElementById("categoryFilter").value = "";
  renderActiveFilters();
  renderList();
}

function clearAllFilters() {
  filters = { type: null, rarity: null, class: null, category: null };
  currentPage = 1;
  document.querySelectorAll(".filter-btn").forEach(btn => btn.className = "filter-btn");
  document.getElementById("categoryFilter").value = "";
  renderActiveFilters();
  renderList();
}

// ---- Render list with pagination ----
function renderList() {
  const filtered = getFiltered();
  const totalPages = Math.max(1, Math.ceil(filtered.length / UNITS_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * UNITS_PER_PAGE;
  const pageUnits = filtered.slice(start, start + UNITS_PER_PAGE);

  if (filtered.length === 0) {
    unitListEl.innerHTML = '<p class="empty">No units found.</p>';
    paginationEl.innerHTML = "";
    return;
  }

  unitListEl.innerHTML = '<div class="unit-grid">' + pageUnits.map(u => `
    <div class="card" onclick="showDetail('${u.id}')">
      ${u.imageURL ? `<img class="card-thumb" src="${u.imageURL}" alt="${escHtml(u.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : '<div class="card-thumb"></div>'}
      <div class="card-info">
        <span class="card-type-dot dot-${u.type}"></span><span class="card-rarity">${u.rarity}</span>${u.transformations.length > 0 ? `<span class="transform-indicator">${u.transformType ? u.transformType.slice(0,3).toUpperCase() : 'TF'}</span>` : ''}${u.hasEza ? '<span class="eza-indicator">EZA</span>' : ''}
        <div class="card-name">${escHtml(u.name)}</div>
      </div>
    </div>
  `).join("") + '</div>';

  paginationEl.innerHTML = `
    <button class="page-btn" onclick="changePage(-1)" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Prev</button>
    <span class="page-info">${currentPage} / ${totalPages} (${filtered.length} units)</span>
    <button class="page-btn" onclick="changePage(1)" ${currentPage >= totalPages ? "disabled" : ""}>Next &raquo;</button>
  `;
}

function changePage(dir) {
  currentPage += dir;
  renderList();
  window.scrollTo(0, 0);
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---- Stat bar ----
function statBar(label, value, max) {
  const pct = Math.min((value / max) * 100, 100);
  return `
    <div class="stat-row">
      <span class="stat-label">${label}</span>
      <div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
      <span class="stat-value">${value.toLocaleString()}</span>
    </div>`;
}

// ---- Build a "form" object for base or transformed state ----
// transformIndex: -1 = base, 0+ = transformation index
// eza: false = non-EZA, true = EZA version
function buildFormData(u, transformIndex, eza) {
  // Base form
  if (transformIndex === -1) {
    const passive = eza && u.ezaPassive ? u.ezaPassive : u.passive;
    const superAtk = eza && u.ezaSuperAttack ? u.ezaSuperAttack : u.superAttack;
    const ultraSuper = eza && u.ezaUltraSuperAttack ? u.ezaUltraSuperAttack : u.ultraSuperAttack;
    const leader = eza && u.ezaLeaderSkill ? u.ezaLeaderSkill : u.leaderSkill;
    const active = eza && u.ezaActiveSkill ? u.ezaActiveSkill : u.activeSkill;
    const activeCond = eza && u.ezaActiveSkillCondition ? u.ezaActiveSkillCondition : u.activeSkillCondition;

    const fakeRaw = {
      name: u.name, type: u.type, class: u.class, rarity: u.rarity,
      passive, superAttack: superAtk, ultraSuperAttack: ultraSuper,
      leaderSkill: leader, links: u.links, categories: u.categories,
    };
    const guide = eza ? blendCommunityInsights(analyzeUnit(fakeRaw), u.id) : u.guide;

    return {
      unitId: u.id, name: u.name, title: u.title, type: u.type, class: u.class, rarity: u.rarity,
      imageURL: u.imageURL, passive, superAttack: superAtk, ultraSuperAttack: ultraSuper,
      activeSkill: active, activeSkillCondition: activeCond, leaderSkill: leader,
      kiMultiplier: u.kiMultiplier, links: u.links, categories: u.categories,
      stats: u.stats, guide, hasStats: true, hasLeader: true,
      exSuperAttack: u.exSuperAttack || null, exSuperCondition: u.exSuperCondition || null,
      formType: null, transformCondition: u.transformCondition || null,
    };
  }

  // Transformed form — supports both old (transformedX) and new (flat) field formats
  const t = u.transformations[transformIndex];

  // New format uses flat field names; old format uses "transformedX" prefix
  const tPassive = t.passive || t.transformedPassive || "Same as base";
  const tSuper = t.superAttack || t.transformedSuperAttack || u.superAttack;
  const tUltraSuper = t.ultraSuperAttack || t.transformedUltraSuperAttack || null;
  const tName = t.name || t.transformedName || u.name;
  const tType = t.type || t.transformedType || u.type;
  const tClass = t.class || t.transformedClass || u.class;
  const tImage = t.imageURL || t.transformedImageURL || u.imageURL;
  const tLinks = (t.links && t.links.length > 0) ? t.links : (t.transformedLinks && t.transformedLinks.length > 0 ? t.transformedLinks : u.links);
  const tCats = (t.categories && t.categories.length > 0) ? t.categories : u.categories;
  const tActive = t.activeSkill || null;
  const tActiveCond = t.activeSkillCondition || null;
  const tExSuper = t.exSuperAttack || null;
  const tExSuperCond = t.exSuperCondition || null;
  const tKi = t.kiMultiplier || u.kiMultiplier;

  // EZA for transformed form
  const tEzaPassive = t.ezaPassive || t.transformedEZAPassive || null;
  const tEzaSuper = t.ezaSuperAttack || t.transformedEZASuperAttack || null;
  const tEzaUltraSuper = t.ezaUltraSuperAttack || t.transformedEZAUltraSuperAttack || null;

  const passive = eza && tEzaPassive ? tEzaPassive : tPassive;
  const superAtk = eza && tEzaSuper ? tEzaSuper : tSuper;
  const ultraSuper = eza && tEzaUltraSuper ? tEzaUltraSuper : tUltraSuper;
  const leader = eza && u.ezaLeaderSkill ? u.ezaLeaderSkill : u.leaderSkill;

  const fakeRaw = {
    name: tName, type: tType, class: tClass, rarity: u.rarity,
    passive, superAttack: superAtk, ultraSuperAttack: ultraSuper,
    leaderSkill: leader, links: tLinks, categories: tCats,
  };
  const guide = blendCommunityInsights(analyzeUnit(fakeRaw), u.id);

  // Form type label (Transformation, Exchange, Tag, Standby, Revive, etc.)
  const formType = t.formType || t.transformType || null;
  const transformCondition = t.transformCondition || t.acquired || null;

  return {
    unitId: u.id, name: tName, title: u.title, type: tType, class: tClass,
    rarity: u.rarity, imageURL: tImage,
    passive, superAttack: superAtk, ultraSuperAttack: ultraSuper,
    activeSkill: tActive, activeSkillCondition: tActiveCond,
    exSuperAttack: tExSuper, exSuperCondition: tExSuperCond,
    leaderSkill: leader, kiMultiplier: tKi, links: tLinks, categories: tCats,
    stats: u.stats, guide, hasStats: false, hasLeader: false,
    formType, transformCondition,
  };
}

// ---- Render a single form (base or transformed) ----
function renderForm(form) {
  const g = form.guide;

  let html = `
    <div class="detail-header">
      ${form.imageURL ? `<img class="detail-thumb" src="${form.imageURL}" alt="${escHtml(form.name)}" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : ""}
      <div class="detail-header-info">
        <div class="card-header" style="justify-content:flex-start;gap:6px;">
          <span class="badge badge-${form.type}">${form.type}</span>
          <span class="badge badge-${form.class.toLowerCase()}">${form.class}</span>
          <span class="rarity">${form.rarity}</span>
        </div>
        <div class="unit-name" style="font-size:24px;font-weight:800">${escHtml(form.name)}</div>
        <div class="unit-title">${escHtml(form.title)}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">HOW TO USE THIS UNIT</div>

      ${g.quickTips.length > 0 ? `
      <div class="guide-block" style="background:#1A1A2E;border:1px solid #FFD70044;">
        <div class="guide-block-title"><span class="icon">&#9889;</span> QUICK TIPS</div>
        ${g.quickTips.map(t => `<div class="quick-tip">${t}</div>`).join("")}
      </div>` : ""}

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#9744;</span> BEST SLOT POSITION</div>
        <div class="slot-box">${g.slot}</div>
        <div class="slot-recommend">${g.slotExplain}</div>
        <div class="guide-block-body">
          ${g.slotReasons.map(r => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${r}</span></div>`).join("")}
          ${g.isGoodLeader ? `<div style="margin-top:8px"><span class="guide-highlight">STRONG LEADER</span> ${g.leaderTip}</div>` : ""}
        </div>
      </div>

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#128737;</span> DEFENSIVE ABILITY</div>
        <div class="guide-block-body">
          ${g.defTips.map(t => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${t}</span></div>`).join("")}
        </div>
      </div>

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#9200;</span> TURN-BY-TURN STRATEGY</div>
        <div class="guide-block-body">
          ${g.turnStrategy.map(phase => {
            const cls = phase.phase.includes("EARLY") ? "phase-early" : phase.phase.includes("MID") ? "phase-mid" : "phase-late";
            return `<div style="margin-bottom:10px">
              <span class="phase-label ${cls}">${phase.phase}</span>
              ${phase.tips.map(t => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${t}</span></div>`).join("")}
            </div>`;
          }).join("")}
        </div>
      </div>

      ${g.transformTips.length > 0 ? `
      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#128260;</span> TRANSFORMATION &amp; ACTIVE SKILL</div>
        <div class="guide-block-body">
          ${g.transformTips.map(t => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${t}</span></div>`).join("")}
        </div>
      </div>` : ""}

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#11044;</span> KI &amp; ORBS</div>
        <div class="guide-block-body">
          ${g.orbAdvice.map(a => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${a}</span></div>`).join("")}
        </div>
      </div>

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#9733;</span> BEST PARTNERS &amp; TEAM</div>
        <div class="guide-block-body">
          ${g.partnerAdvice.map(a => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${a}</span></div>`).join("")}
        </div>
      </div>

      <div class="guide-block">
        <div class="guide-block-title"><span class="icon">&#127919;</span> WHERE TO USE</div>
        <div class="guide-block-body">
          ${g.contentAdvice.map(a => `<div class="tip-item"><span class="tip-bullet">▸</span><span>${a}</span></div>`).join("")}
        </div>
      </div>
    </div>`;

  if (form.hasStats) {
    html += `
    <div class="section">
      <div class="section-title">STATS (Rainbow)</div>
      ${statBar("HP", form.stats.hp, 30000)}
      ${statBar("ATK", form.stats.atk, 25000)}
      ${statBar("DEF", form.stats.def, 18000)}
    </div>`;
  }

  if (form.hasLeader) {
    html += `
    <div class="section">
      <div class="section-title">LEADER SKILL</div>
      <div class="section-body">${escHtml(form.leaderSkill)}</div>
    </div>`;
  }

  html += `
    <div class="section">
      <div class="section-title">PASSIVE SKILL</div>
      <div class="section-body">${escHtml(form.passive)}</div>
    </div>

    <div class="section">
      <div class="section-title">SUPER ATTACK</div>
      <div class="section-body">${escHtml(form.superAttack)}</div>
    </div>`;

  if (form.ultraSuperAttack) {
    html += `
    <div class="section">
      <div class="section-title">ULTRA SUPER ATTACK (18 Ki)</div>
      <div class="section-body">${escHtml(form.ultraSuperAttack)}</div>
    </div>`;
  }

  if (form.formType) {
    html += `
    <div class="section">
      <div class="section-title" style="color:#FF9800">${escHtml(form.formType.toUpperCase())} FORM</div>
      ${form.transformCondition ? `<div class="section-body" style="color:#ccc;font-size:13px">${escHtml(form.transformCondition)}</div>` : ""}
    </div>`;
  }

  if (form.activeSkill) {
    html += `
    <div class="section">
      <div class="section-title">ACTIVE SKILL</div>
      ${form.activeSkillCondition ? `<div class="condition">Condition: ${escHtml(form.activeSkillCondition)}</div>` : ""}
      <div class="section-body">${escHtml(form.activeSkill)}</div>
    </div>`;
  }

  if (form.exSuperAttack) {
    html += `
    <div class="section">
      <div class="section-title">EX SUPER ATTACK</div>
      ${form.exSuperCondition ? `<div class="condition">Condition: ${escHtml(form.exSuperCondition)}</div>` : ""}
      <div class="section-body">${escHtml(form.exSuperAttack)}</div>
    </div>`;
  }

  if (form.kiMultiplier) {
    html += `
    <div class="section">
      <div class="section-title">KI MULTIPLIER</div>
      <div class="section-body">${escHtml(form.kiMultiplier)}</div>
    </div>`;
  }

  html += `
    <div class="section">
      <div class="section-title">LINK SKILLS (${form.links.length})</div>
      <div class="tags">${form.links.map(l => `<span class="tag">${escHtml(l)}</span>`).join("")}</div>
    </div>

    <div class="section">
      <div class="section-title">CATEGORIES (${form.categories.length})</div>
      <div class="tags">${form.categories.map(c => `<span class="tag tag-cat">${escHtml(c)}</span>`).join("")}</div>
    </div>`;

  // ---- Community Notes (from Reddit) ----
  html += renderCommunityNotes(form.unitId);

  return html;
}

// ---- Community Notes Renderer ----
function renderCommunityNotes(unitId) {
  // Community gameplay insights are now blended directly into the guide sections
  // (defTips, slotReasons, partnerAdvice, contentAdvice, quickTips)
  // marked with [Community] tags. No separate community section needed
  // unless there are extra insights not covered by the guide categories.
  if (typeof EMBEDDED_REDDIT === "undefined") return "";
  const ci = (EMBEDDED_REDDIT.unitInsights || {})[unitId];
  if (!ci) return "";

  // Check if there are any leftover general insights not in guide sections
  const general = ci.general || [];
  if (general.length === 0) return "";

  let html = `<div class="community-section">
    <div class="community-header">&#128172; COMMUNITY NOTES</div>`;
  for (const tip of general.slice(0, 3)) {
    html += `<div class="community-tip"><span class="ct-bullet">&#9670;</span><span>${escHtml(tip)}</span></div>`;
  }
  html += `</div>`;
  return html;
}

// ---- Detail view ----
let currentDetailUnit = null;
let currentTransformIndex = -1;
let currentEza = false;

function showDetail(id) {
  const u = allUnits.find(x => x.id === id);
  if (!u) return;

  currentDetailUnit = u;
  currentTransformIndex = -1;
  // Default to EZA view if unit has EZA (show the best version first)
  currentEza = u.hasEza;
  listView.classList.add("hidden");
  detailView.classList.add("active");

  renderDetailForm(currentTransformIndex, currentEza);
  window.scrollTo(0, 0);
}

function renderDetailForm(transformIndex, eza) {
  const u = currentDetailUnit;
  if (!u) return;

  currentTransformIndex = transformIndex;
  currentEza = eza;

  const hasTransforms = u.transformations && u.transformations.length > 0;
  let html = "";

  // EZA toggle (show if unit has EZA data)
  if (u.hasEza) {
    html += '<div class="transform-tabs">';
    html += `<button class="transform-tab ${!eza ? "active" : ""}" onclick="renderDetailForm(${transformIndex}, false)">Pre-EZA</button>`;
    html += `<button class="transform-tab ${eza ? "active" : ""}" onclick="renderDetailForm(${transformIndex}, true)">EZA</button>`;
    html += '</div>';
  }

  // Transform tabs (show if unit has transformations)
  if (hasTransforms) {
    html += '<div class="transform-tabs">';
    html += `<button class="transform-tab ${transformIndex === -1 ? "active" : ""}" onclick="renderDetailForm(-1, ${eza})">Base</button>`;
    u.transformations.forEach((t, i) => {
      const label = t.name || t.transformedName || t.tabLabel || ("Form " + (i + 2));
      const typeTag = t.formType || t.transformType || "";
      const btnLabel = typeTag ? `${label}` : label;
      html += `<button class="transform-tab ${transformIndex === i ? "active" : ""}" onclick="renderDetailForm(${i}, ${eza})">${escHtml(btnLabel)}</button>`;
    });
    html += '</div>';
  }

  const form = buildFormData(u, transformIndex, eza);
  html += renderForm(form);

  detailContent.innerHTML = html;
  window.scrollTo(0, 0);
}

// ---- Event listeners ----
backBtn.addEventListener("click", () => {
  detailView.classList.remove("active");
  listView.classList.remove("hidden");
});

let searchTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentPage = 1;
    renderList();
  }, 200);
});

// Filter buttons — toggle on/off within each group
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const group = btn.dataset.group;
    const value = btn.dataset.value;

    // If already active, turn it off
    if (filters[group] === value) {
      filters[group] = null;
      btn.className = "filter-btn";
    } else {
      // Deactivate other buttons in same group
      document.querySelectorAll(`.filter-btn[data-group="${group}"]`).forEach(b => {
        b.className = "filter-btn";
      });
      // Activate this one
      filters[group] = value;
      const typeColors = ["INT","AGL","TEQ","STR","PHY"];
      const classColors = ["super","extreme"];
      if (typeColors.includes(value)) {
        btn.classList.add("active-" + value);
      } else if (classColors.includes(value.toLowerCase())) {
        btn.classList.add("active-" + value.toLowerCase());
      } else {
        btn.classList.add("active");
      }
    }

    currentPage = 1;
    renderActiveFilters();
    renderList();
  });
});

// Category dropdown
document.getElementById("categoryFilter").addEventListener("change", (e) => {
  filters.category = e.target.value || null;
  currentPage = 1;
  renderActiveFilters();
  renderList();
});

// ---- Start ----
loadData();
