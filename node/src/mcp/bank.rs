//! The Bank and the Market (plans/MCP.md, _The Bank and the Market_): the persona's HorseBucks,
//! what they were earned from and what they hold, what's for sale, and buying and selling.
//!
//! HorseBucks are pretend money (Curtis, 2026-10-06: "horsebucks are vacuous and imaginary"), so
//! nothing here is marked destructive: an agent that plays the market badly costs nobody anything.
//! The doors keep the rules - no overdraft, a commodity held two days before it sells, a bond sold
//! only from debt - and their refusals reach the agent in their own words.
//!
//! The gates follow the app's Market (js/apps/bank.js): unlocks are for sale to everyone, and the
//! instruments - hrseBonds and the commodities - are Horse Financial's. Amounts cross as pennies,
//! exact decimal strings of any length (bank.rs), and reach the agent as HorseBucks.

use axum::http::{request::Parts, Method};
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{answer, escape, finish, horsebucks, stop, when, Answer, Tools};

/// How many ledger lines `bank` shows.
const LINES_SHOWN: usize = 10;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct PersonaArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct BuyArgs {
    /// Which persona buys: its name, its @slug or its root. Leave it out when the account has only
    /// one.
    persona: Option<String>,
    /// An unlock or a colourway, by its id or its name, as market lists it.
    unlock: Option<String>,
    /// A commodity, by its id ("hay", "oats", ...), with `units`. Needs Horse Financial.
    commodity: Option<String>,
    /// How many whole units of the commodity.
    units: Option<String>,
    /// A hrseBond, for this many HorseBucks ("2000", "2,500.50"). Needs Horse Financial.
    bond: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SellArgs {
    /// Which persona sells: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// A commodity lot, by its id from bank's holdings - sellable two days after it was bought.
    lot: Option<String>,
    /// How many of the lot's units; all of them if left out.
    units: Option<String>,
    /// A hrseBond, by its id from bank's holdings - sold only to get out of debt.
    bond: Option<String>,
}

/// HorseBucks as an agent writes them ("2000", "2,500.5", "H$ 12.05") in pennies, as an exact
/// decimal string - or None for anything else, or a fraction of a penny.
fn pennies_of(amount: &str) -> Option<String> {
    let cleaned: String = amount
        .trim()
        .trim_start_matches("H$")
        .trim()
        .chars()
        .filter(|c| *c != ',' && *c != '_')
        .collect();
    let (whole, cents) = cleaned.split_once('.').unwrap_or((&cleaned, ""));
    if whole.is_empty() && cents.is_empty() {
        return None;
    }
    if !whole.chars().all(|c| c.is_ascii_digit()) || !cents.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if cents.len() > 2 {
        return None;
    }
    let pennies = format!("{whole}{cents:0<2}");
    let pennies = pennies.trim_start_matches('0');
    Some(if pennies.is_empty() { "0".into() } else { pennies.into() })
}

/// Whole units, as the doors take them: digits only, above nothing.
fn whole_units(units: &str) -> Option<String> {
    let units = units.trim();
    (!units.is_empty()
        && units.chars().all(|c| c.is_ascii_digit())
        && !units.trim_start_matches('0').is_empty())
    .then(|| units.to_string())
}

/// A pennies field as HorseBucks, for an answer: `H$ 1,234.05`, or null where there is none.
fn money(v: Option<&Value>) -> Value {
    v.and_then(Value::as_str).map_or(Value::Null, |p| json!(format!("H$ {}", horsebucks(p))))
}

impl Tools {
    async fn bank_answer(&self, parts: &Parts, args: PersonaArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let bank = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{}/bank?lines={LINES_SHOWN}", persona.root),
                None,
            )
            .await?;
        let goods = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{}/bank/commodities", persona.root),
                None,
            )
            .await?;
        let earned: serde_json::Map<String, Value> = bank
            .get("by_kind")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .map(|(kind, pennies)| (kind.clone(), money(Some(pennies))))
            .collect();
        let contracts: Vec<Value> = bank
            .get("contracts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|c| c.get("completed_ms").is_none_or(Value::is_null))
            .map(|c| json!({ "contract": c.get("name"), "reward": money(c.get("pennies")), "needs": c.get("requires") }))
            .collect();
        let lines: Vec<Value> = bank
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(LINES_SHOWN)
            .map(|l| {
                json!({
                    "when": when(l.get("at_ms").and_then(Value::as_i64)),
                    "for": l.get("kind"),
                    "about": l.get("detail").and_then(|d| d.get("title")).or_else(|| l.get("source")),
                    "amount": money(l.get("pennies")),
                })
            })
            .collect();
        let bonds: Vec<Value> = bank
            .get("instruments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|b| {
                json!({
                    "bond": b.get("id"),
                    "bought": when(b.get("bought_ms").and_then(Value::as_i64)),
                    "price": money(b.get("pennies")),
                    "paid_so_far": money(b.get("paid")),
                    "days": b.get("days"),
                    "of_days": b.get("of_days"),
                    "matured": b.get("matured"),
                    "sold": b.get("sold"),
                })
            })
            .collect();
        let lots: Vec<Value> = goods
            .get("lots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|l| {
                json!({
                    "lot": l.get("id"),
                    "commodity": l.get("commodity"),
                    "units": l.get("units"),
                    "bought_at": money(l.get("price")),
                    "worth_now": money(l.get("worth")),
                    "sellable": l.get("sellable"),
                    "sellable_from": when(l.get("sellable_from_ms").and_then(Value::as_i64)),
                })
            })
            .collect();
        answer(json!({
            "persona": { "name": persona.name, "root": persona.root },
            "balance": money(bank.get("balance")),
            "earned_from": earned,
            "open_contracts": contracts,
            "recent": lines,
            "bonds": bonds,
            "commodity_lots": lots,
        }))
    }

    async fn market_answer(&self, parts: &Parts, args: PersonaArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let bank = self
            // One line, not none: `lines=0` is the corner's poll, the balance alone (bank.rs
            // `bank_handler`), and the Market needs the unlocks with their prices.
            .call(parts, Method::GET, &format!("/api/identity/{}/bank?lines=1", persona.root), None)
            .await?;
        let owned = self.unlocks(parts, &persona.root).await?;
        let mut unlocks = Vec::new();
        let mut colourways = Vec::new();
        for u in bank.get("unlocks").and_then(Value::as_array).into_iter().flatten() {
            if u.get("bought_ms").is_some_and(|b| !b.is_null()) {
                continue;
            }
            let id = u.get("id").and_then(Value::as_str).unwrap_or_default();
            if owned.require(id).is_ok() {
                continue; // the test rig's every-unlock answer
            }
            let mut row = json!({ "id": id, "name": u.get("name"), "price": money(u.get("pennies")), "needs_first": u.get("requires") });
            // Another persona of this account owns it here: 5% of the price (bank.rs
            // `owned_elsewhere`), and why.
            if u.get("elsewhere").and_then(Value::as_bool) == Some(true) {
                row["full_price"] = money(u.get("full_pennies"));
                row["discount"] = json!("95% off: another persona of this account already owns it");
            }
            if id.starts_with("colorway-") {
                colourways.push(row);
            } else {
                unlocks.push(row);
            }
        }
        let financial = owned.require("horse-financial").is_ok();
        let mut market = json!({
            "persona": { "name": persona.name, "root": persona.root },
            "balance": money(bank.get("balance")),
            "unlocks": unlocks,
            "colourways": colourways,
        });
        if financial {
            let goods = self
                .call(
                    parts,
                    Method::GET,
                    &format!("/api/identity/{}/bank/commodities", persona.root),
                    None,
                )
                .await?;
            let commodities: Vec<Value> = goods
                .get("commodities")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|c| {
                    let history = c.get("history").and_then(Value::as_array);
                    let month_ago = history.and_then(|h| h.first()).and_then(|d| d.get("price"));
                    json!({
                        "commodity": c.get("id"),
                        "price_today": money(c.get("price")),
                        "price_a_month_ago": money(month_ago),
                    })
                })
                .collect();
            market["commodities"] = json!(commodities);
            market["bonds"] = json!({
                "from": format!("H$ {}", horsebucks(&crate::bank::BOND_MIN.to_string())),
                "to": format!("H$ {}", horsebucks(&crate::bank::BOND_MAX.to_string())),
            });
        } else {
            market["instruments"] =
                json!("hrseBonds and commodities need the Horse Financial unlock");
        }
        answer(market)
    }

    async fn buy_answer(&self, parts: &Parts, args: BuyArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let bank = format!("/api/identity/{}/bank", persona.root);
        match (args.unlock.as_deref(), args.commodity.as_deref(), args.bond.as_deref()) {
            (Some(wanted), None, None) => {
                let wanted = wanted.trim();
                let found = crate::bank::UNLOCKS.iter().find(|u| {
                    u.id.eq_ignore_ascii_case(wanted) || u.name.eq_ignore_ascii_case(wanted)
                });
                let Some(unlock) = found else {
                    return Err(stop(format!(
                        "there's no unlock called \"{wanted}\": market lists them"
                    )));
                };
                self.call(
                    parts,
                    Method::POST,
                    &format!("{bank}/unlocks"),
                    Some(json!({ "id": unlock.id })),
                )
                .await?;
                answer(json!({ "bought": unlock.name }))
            }
            (None, Some(commodity), None) => {
                self.require(parts, &persona.root, "horse-financial").await?;
                let Some(units) = args.units.as_deref().and_then(whole_units) else {
                    return Err(stop("say how many whole units, as `units`"));
                };
                let lot = self
                    .call(
                        parts,
                        Method::POST,
                        &format!("{bank}/commodities"),
                        Some(json!({ "commodity": commodity.trim().to_ascii_lowercase(), "units": units })),
                    )
                    .await?;
                answer(
                    json!({ "bought": format!("{units} {}", commodity.trim()), "lot": lot.get("id").or_else(|| lot.get("lot")) }),
                )
            }
            (None, None, Some(amount)) => {
                self.require(parts, &persona.root, "horse-financial").await?;
                let Some(pennies) = pennies_of(amount) else {
                    return Err(stop(format!("\"{amount}\" isn't an amount of HorseBucks")));
                };
                self.call(
                    parts,
                    Method::POST,
                    &format!("{bank}/instruments"),
                    Some(json!({ "kind": "horsebond", "pennies": pennies })),
                )
                .await?;
                answer(json!({ "bought": format!("a hrseBond for H$ {}", horsebucks(&pennies)) }))
            }
            _ => Err(stop(
                "buy one thing at a time: an `unlock`, a `commodity` with `units`, or a `bond`",
            )),
        }
    }

    async fn sell_answer(&self, parts: &Parts, args: SellArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "horse-financial").await?;
        let bank = format!("/api/identity/{}/bank", persona.root);
        match (args.lot.as_deref(), args.bond.as_deref()) {
            (Some(lot), None) => {
                let lot = lot.trim();
                let units = match args.units.as_deref() {
                    Some(units) => match whole_units(units) {
                        Some(units) => units,
                        None => return Err(stop("say how many whole units, as `units`")),
                    },
                    // All of it: what the lot holds now, from the holdings.
                    None => {
                        let goods = self
                            .call(parts, Method::GET, &format!("{bank}/commodities"), None)
                            .await?;
                        let held = goods
                            .get("lots")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .find(|l| l.get("id").and_then(Value::as_str) == Some(lot))
                            .and_then(|l| {
                                l.get("units").and_then(Value::as_str).map(str::to_string)
                            });
                        match held {
                            Some(units) => units,
                            None => {
                                return Err(stop(format!(
                                    "there's no lot \"{lot}\" held: bank lists them"
                                )))
                            }
                        }
                    }
                };
                self.call(
                    parts,
                    Method::POST,
                    &format!("{bank}/commodities/{}/sell", escape(lot)),
                    Some(json!({ "units": units })),
                )
                .await?;
                answer(json!({ "sold": format!("{units} from lot {lot}") }))
            }
            (None, Some(bond)) => {
                let bond = bond.trim();
                self.call(
                    parts,
                    Method::POST,
                    &format!("{bank}/instruments/{}/sell", escape(bond)),
                    None,
                )
                .await?;
                answer(json!({ "sold": format!("bond {bond}") }))
            }
            _ => Err(stop(
                "sell one thing at a time: a `lot` (with `units`, or all of it), or a `bond`",
            )),
        }
    }
}

#[tool_router(router = bank_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "The persona's Bank: its HorseBucks balance, what it earned them from, the \
            contracts still open (and what each pays), recent ledger lines, and what it holds - \
            hrseBonds and commodity lots. HorseBucks are pretend money.",
        annotations(title = "The Bank", read_only_hint = true)
    )]
    async fn bank(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PersonaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.bank_answer(&parts, args).await)
    }

    #[tool(
        description = "The Market: the unlocks and colourways the persona can still buy, with \
            prices and what each needs first; and, with Horse Financial, today's commodity \
            prices and what a hrseBond may cost.",
        annotations(title = "The Market", read_only_hint = true)
    )]
    async fn market(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PersonaArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.market_answer(&parts, args).await)
    }

    #[tool(
        description = "Buy one thing with HorseBucks: an unlock or a colourway (by id or name), \
            whole units of a commodity, or a hrseBond for an amount. No overdraft. Commodities and \
            bonds need Horse Financial.",
        annotations(title = "Buy", read_only_hint = false, destructive_hint = false)
    )]
    async fn buy(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<BuyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.buy_answer(&parts, args).await)
    }

    #[tool(
        description = "Sell a commodity lot (some or all of it, two days after buying it) at \
            today's price, or a hrseBond (only to get out of debt). Needs Horse Financial.",
        annotations(title = "Sell", read_only_hint = false, destructive_hint = false)
    )]
    async fn sell(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<SellArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.sell_answer(&parts, args).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horsebucks_as_written_become_exact_pennies() {
        assert_eq!(pennies_of("2000").as_deref(), Some("200000"));
        assert_eq!(pennies_of("2,500.5").as_deref(), Some("250050"));
        assert_eq!(pennies_of("H$ 12.05").as_deref(), Some("1205"));
        assert_eq!(pennies_of(".07").as_deref(), Some("7"));
        assert_eq!(pennies_of("0").as_deref(), Some("0"));
        assert_eq!(pennies_of("1.005"), None, "no fractions of a penny");
        assert_eq!(pennies_of("-5"), None, "a purchase is never negative");
        assert_eq!(pennies_of("lots"), None);
        assert_eq!(pennies_of(""), None);
    }

    #[test]
    fn units_are_whole_and_more_than_none() {
        assert_eq!(whole_units(" 12 ").as_deref(), Some("12"));
        assert_eq!(whole_units("0"), None);
        assert_eq!(whole_units("1.5"), None);
        assert_eq!(whole_units("-3"), None);
    }
}
