// hrseCommodities' words (plans/COMMODITIES.md, 2026-10-06), in the reader's language. The node
// keeps the commodities - their walks, their weather, the lots (commodities.rs) - and names them
// by id; the names and the weather a person reads come from here, one literal `t()` apiece, as
// contracts.js names contracts. A commodity this table doesn't know wears its id.
import { t } from './i18n.js';

const NAMES = {
    hay: () => t('commodities.hay', 'hay'),
    oats: () => t('commodities.oats', 'oats'),
    carrots: () => t('commodities.carrots', 'carrots'),
    apples: () => t('commodities.apples', 'apples'),
    bridles: () => t('commodities.bridles', 'bridles'),
    horseshoes: () => t('commodities.horseshoes', 'horseshoes'),
    saddles: () => t('commodities.saddles', 'saddles'),
};

/// What each signal says when the week is busier than the month, and when it's quieter.
const WEATHER = {
    drawings: [
        () => t('commodities.more-drawings', 'more drawing than usual'),
        () => t('commodities.fewer-drawings', 'less drawing than usual'),
    ],
    words: [
        () => t('commodities.more-words', 'more words than usual'),
        () => t('commodities.fewer-words', 'fewer words than usual'),
    ],
    positive: [
        () => t('commodities.more-positive', 'more positive reactions than usual'),
        () => t('commodities.fewer-positive', 'fewer positive reactions than usual'),
    ],
    negative: [
        () => t('commodities.more-negative', 'more negative reactions than usual'),
        () => t('commodities.fewer-negative', 'fewer negative reactions than usual'),
    ],
    chat: [
        () => t('commodities.more-chat', 'more chatter than usual'),
        () => t('commodities.fewer-chat', 'less chatter than usual'),
    ],
    follows: [
        () => t('commodities.more-follows', 'more new follows than usual'),
        () => t('commodities.fewer-follows', 'fewer new follows than usual'),
    ],
    posts: [
        () => t('commodities.more-posts', 'more posting than usual'),
        () => t('commodities.fewer-posts', 'less posting than usual'),
    ],
};

/// The commodity's name as the reader reads it.
export const commodityName = (id) => (NAMES[id] ? NAMES[id]() : id);

/// The weather in words - "↑ 4% · more drawing than usual" - or a calm word when there's none.
export const weatherWords = (signal, permille) => {
    const pct = Math.round(Math.abs(permille) / 10);
    if (pct === 0) return t('commodities.calm', 'calm');
    const [more, fewer] = WEATHER[signal] || [() => '', () => ''];
    return permille > 0 ? `↑ ${pct}% · ${more()}` : `↓ ${pct}% · ${fewer()}`;
};
