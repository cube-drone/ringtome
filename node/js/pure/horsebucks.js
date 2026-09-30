// HorseBucks as a person reads them (HORSE_BASED_CURRENCIES.md, "Stinkingly broken numbers"): the
// node keeps a balance as exact horsepennies (a hundredth of a HorseBuck, sent as a decimal string -
// a bigint); this is the broken-number notation it's shown in. Under a million, the whole amount to
// the penny: `H$ 1,234.56`. Past that, a few digits and the magnitude named: the short scale up to
// centillion (10^303), then "jillions", one per step of a thousand, named from the pinned word list
// by stepping through it with a stride coprime with its length, so every magnitude has its own word:
// acidjillion is 10^306, poutjillion 10^309, and so on.
import { WORDS } from './words.js';

const SMALL = ['m', 'b', 'tr', 'quadr', 'quint', 'sext', 'sept', 'oct', 'non'];
const UNITS = ['', 'un', 'duo', 'tre', 'quattuor', 'quin', 'sex', 'septen', 'octo', 'novem'];
const TENS = ['', 'dec', 'vigint', 'trigint', 'quadragint', 'quinquagint', 'sexagint', 'septuagint', 'octogint', 'nonagint'];

/// The name of 10^(3n + 3): million is n = 1, centillion n = 100, and past it the jillions.
export function magnitudeName(n) {
    if (n < 1) return '';
    if (n < 10) return `${SMALL[n - 1]}illion`;
    if (n < 100) return `${UNITS[n % 10]}${TENS[Math.floor(n / 10)]}illion`;
    if (n === 100) return 'centillion';
    const j = n - 101; // acidjillion is the first past centillion
    const word = (k) => WORDS[(799 * k) % WORDS.length];
    // Past the list's length, two words: the next word before the first, the way odometers carry.
    return j < WORDS.length ? `${word(j)}jillion` : `${word(Math.floor(j / WORDS.length) - 1)}${word(j % WORDS.length)}jillion`;
}

const grouped = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/// A balance in horsepennies (a decimal string, a bigint or a number) as `H$ 1,234.56` or
/// `H$ 18.39 squidjillion`. Negative balances keep their sign: debt reads as debt.
export function formatHorseBucks(pennies) {
    let p;
    try {
        p = BigInt(pennies ?? 0);
    } catch {
        p = 0n;
    }
    const sign = p < 0n ? '-' : '';
    const abs = p < 0n ? -p : p;
    const bucks = abs / 100n;
    const cents = String(abs % 100n).padStart(2, '0');
    const digits = String(bucks);
    if (digits.length <= 6) return `${sign}H$ ${grouped(digits)}.${cents}`;
    // Group into thousands: the magnitude is how many groups past the first two.
    const n = Math.floor((digits.length - 1) / 3) - 1;
    const lead = digits.length - 3 * (n + 1);
    const whole = digits.slice(0, lead);
    const frac = digits.slice(lead, lead + 2);
    return `${sign}H$ ${whole}.${frac} ${magnitudeName(n)}`;
}
