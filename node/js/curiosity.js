// The curiosity dial in words (Curtis's design), for every place that shows the dial: the feed, and
// hrseAmp's filter strip (plans/AUDIO.md, section 3).

import { t } from './i18n.js';

/// The curiosity dial's stops (pure/selectivity.js keeps the keys), in words a translation can
/// carry - Curtis's design, verbatim, in English.
export const STOP_WORDS = {
    explorer: () => t('apps.feed.stop-explorer', 'explorer'),
    'highly-speculative': () => t('apps.feed.stop-highly-speculative', 'highly speculative'),
    speculative: () => t('apps.feed.stop-speculative', 'speculative'),
    interest: () => t('apps.feed.stop-interest', 'interest only'),
    medium: () => t('apps.feed.stop-medium', 'medium interest only'),
    high: () => t('apps.feed.stop-high', 'high interest only'),
};
