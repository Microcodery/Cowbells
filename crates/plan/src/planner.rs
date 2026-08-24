//! Label-setting search over viewpoints: where to stand, when to leave.
//!
//! A label is "standing at viewpoint `c`, free to leave at `depart`, having
//! scored `score` with a given history of who has been seen". Arriving and
//! staying until some window closes covers every window that opens after
//! arrival and closes before leaving, so each move has one successor per
//! distinct close time. Value is marginal: repeat sightings of a racer are
//! worth less, so the history is part of the state and of dominance.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use birdseye_core::{Objective, Prefer, Seconds};
use fixedbitset::FixedBitSet;

use crate::trace::LabelEvent;
use crate::viewpoints::{Kind, Sighting};

/// Search events are handed to the sink in batches of this many.
const EVENT_BATCH: usize = 2_000;

/// Everything the search reads: sightings per viewpoint, how long it takes to move between
/// them, and the constraints on the day. Geometry stays with the caller.
pub struct Problem {
    /// `sightings[v]` is what viewpoint `v` offers, sorted by window open time.
    pub sightings: Vec<Vec<Sighting>>,
    /// `travel[a][b]` seconds between viewpoints; `None` when unreachable.
    /// Must satisfy the triangle inequality (true for shortest-path times).
    pub travel: Vec<Vec<Option<Seconds>>>,
    /// Viewpoint the spectator starts at; when absent the planner chooses.
    pub start: Option<usize>,
    pub earliest: Seconds,
    pub latest: Option<Seconds>,
    /// Viewpoint the spectator must end at, and the latest arrival there.
    pub end: Option<(usize, Seconds)>,
    pub min_stop: Seconds,
    pub priorities: Vec<f64>,
    /// Per racer, which kind of sighting matters most.
    pub prefer: Vec<Prefer>,
    pub objective: Objective,
    pub regions: Vec<Region>,
}

/// A required region resolved onto viewpoints.
#[derive(Debug)]
pub struct Region {
    pub inside: FixedBitSet,
    pub latest: Option<Seconds>,
}

/// Objective weights resolved for a field of racers; each level outweighs everything the
/// levels below it could accumulate, so the scalar score ranks plans lexicographically.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Weights {
    /// Bonus once every racer has had their preferred sighting.
    everyone_preferred: f64,
    /// Bonus once every racer's finish has been seen; zero when finishes are required instead.
    everyone_finished: f64,
    /// A racer's first sighting of their preferred kind, scaled by priority.
    preferred: f64,
    /// A racer's first sighting of the other kind, scaled by priority.
    other: f64,
    /// The `k`-th en-route sighting of a racer is worth `priority × repeat_decay^k` of this.
    repeat: f64,
    /// Charged per finish missed when finishes are required: more than every level earns.
    missed_finish: f64,
    /// Charged per required region missed: more than every level and every finish could earn.
    missed_region: f64,
}

pub(crate) fn weights(objective: &Objective, racers: usize, max_priority: f64) -> Weights {
    let level = level_base(objective, racers, max_priority);
    let required = objective.require_finishes;
    Weights {
        everyone_preferred: level.powi(4),
        everyone_finished: if required { 0.0 } else { level.powi(3) },
        preferred: level.powi(2),
        other: level,
        repeat: 1.0,
        missed_finish: if required { level.powi(5) } else { 0.0 },
        missed_region: level.powi(6),
    }
}

/// Ten times the most a single level can be worth, so the scalar stays exact in f64 for
/// fields of hundreds of racers.
pub(crate) fn level_base(objective: &Objective, racers: usize, max_priority: f64) -> f64 {
    let repeats = 1.0 / (1.0 - objective.repeat_decay.clamp(0.0, 0.9));
    let most = (racers.max(1) as f64 * max_priority.max(1.0) * repeats).max(1.0);
    (10.0 * most).ceil()
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Labels kept per viewpoint; more is slower and closer to optimal.
    pub beam: usize,
    /// Report search events to the sink as the search runs (see `trace::LabelEvent`).
    pub trace: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { beam: 64, trace: false }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    pub viewpoint: usize,
    pub arrive: Seconds,
    pub depart: Seconds,
    /// Indices into `Problem::sightings[viewpoint]`.
    pub sightings: Vec<usize>,
}

/// Raw solver output referencing viewpoints and sightings by index; `Itinerary` is the
/// rendered form.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// Begins at the start anchor when there is one and ends at the end anchor when there is one.
    pub stops: Vec<Stop>,
    pub score: f64,
    /// Indices of required regions no stop falls inside.
    pub unmet_regions: Vec<usize>,
}

/// The best itinerary the beam finds; exact when the beam is wide enough.
pub fn plan(problem: &Problem, options: Options) -> Plan {
    plan_with(problem, options, &mut |_| {})
}

fn max_priority(problem: &Problem) -> f64 {
    problem.priorities.iter().copied().fold(0.0, f64::max)
}

/// `plan`, reporting search events to `sink` in batches as it goes when `options.trace` is set.
pub fn plan_with(
    problem: &Problem,
    options: Options,
    sink: &mut dyn FnMut(Vec<LabelEvent>),
) -> Plan {
    let (racers, top) = (problem.priorities.len(), max_priority(problem));
    let mut search = Search {
        problem,
        options,
        sink,
        weights: weights(&problem.objective, racers, top),
        field: (0..racers).filter(|&r| problem.priorities[r] > 0.0).collect(),
        labels: Vec::new(),
        kept: vec![Vec::new(); problem.sightings.len()],
        queue: BinaryHeap::new(),
        events: Vec::new(),
    };
    let roots: Vec<usize> = match problem.start {
        Some(start) => vec![start],
        None => (0..problem.sightings.len()).collect(),
    };
    for root in roots {
        let label = Label::root(root, problem);
        if let Some(index) = search.push(label) {
            search.dwell(index, root, problem.earliest);
        }
    }
    while let Some(Queued { label, .. }) = search.queue.pop() {
        if search.labels[label].alive {
            search.expand(label);
        }
    }
    search.flush();
    search.best_plan()
}

#[derive(Debug, Clone)]
struct Label {
    viewpoint: usize,
    arrive: Seconds,
    depart: Seconds,
    score: f64,
    /// En-route sightings so far, per racer.
    seen: Vec<u8>,
    finished: FixedBitSet,
    regions_done: FixedBitSet,
    newly_covered: Vec<usize>,
    parent: Option<usize>,
    /// Cleared when the beam drops this label; it then neither expands nor wins.
    alive: bool,
}

impl Label {
    fn root(viewpoint: usize, problem: &Problem) -> Self {
        let mut label = Label {
            viewpoint,
            arrive: problem.earliest,
            depart: problem.earliest,
            score: 0.0,
            seen: vec![0; problem.priorities.len()],
            finished: FixedBitSet::with_capacity(problem.priorities.len()),
            regions_done: FixedBitSet::with_capacity(problem.regions.len()),
            newly_covered: Vec::new(),
            parent: None,
            alive: true,
        };
        label.visit_regions(problem);
        label
    }

    /// A dead label only serves to reconstruct its descendants' paths; drop the rest.
    fn kill(&mut self) {
        self.alive = false;
        self.seen = Vec::new();
        self.finished = FixedBitSet::default();
        self.regions_done = FixedBitSet::default();
    }

    fn visit_regions(&mut self, problem: &Problem) {
        for (i, region) in problem.regions.iter().enumerate() {
            let in_time = region.latest.is_none_or(|t| self.arrive <= t);
            if region.inside.contains(self.viewpoint) && in_time {
                self.regions_done.insert(i);
            }
        }
    }
}

/// Heap entry ordered so the earliest departure pops first.
#[derive(PartialEq)]
struct Queued {
    depart: Seconds,
    label: usize,
}

impl Eq for Queued {}

impl Ord for Queued {
    fn cmp(&self, other: &Self) -> Ordering {
        other.depart.total_cmp(&self.depart).then_with(|| other.label.cmp(&self.label))
    }
}

impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// `a` leaves no later, scores no less, and has at least as much left to gain. Sound because
/// every sighting of a racer who counts is worth strictly more to the label that lacks it.
fn dominates(a: &Label, b: &Label) -> bool {
    // `kept` never holds a dead label, but `Label::kill` empties the sets this compares, so
    // the guard keeps a stray dead `a` from dominating everything on truncated fields.
    a.alive
        && a.depart <= b.depart
        && a.score >= b.score
        && a.seen.iter().zip(&b.seen).all(|(x, y)| x <= y)
        && a.finished.is_subset(&b.finished)
        && a.regions_done.is_superset(&b.regions_done)
}

struct Search<'a> {
    problem: &'a Problem,
    options: Options,
    weights: Weights,
    /// Racers with positive priority: the ones "everyone" means.
    field: Vec<usize>,
    labels: Vec<Label>,
    /// Surviving label indices per viewpoint, for dominance and the beam.
    kept: Vec<Vec<usize>>,
    queue: BinaryHeap<Queued>,
    sink: &'a mut dyn FnMut(Vec<LabelEvent>),
    events: Vec<LabelEvent>,
}

impl Search<'_> {
    /// Keeps the label unless it is dominated, hopeless, or squeezed out by the beam.
    fn push(&mut self, label: Label) -> Option<usize> {
        if !self.can_still_finish(&label) {
            return None;
        }
        if self.dominated(&label) {
            self.record(LabelEvent::Dominated { parent: label.parent, viewpoint: label.viewpoint });
            return None;
        }
        let index = self.labels.len();
        let at = label.viewpoint;
        self.evict_dominated_by(&label);
        self.record(LabelEvent::Kept {
            label: index,
            parent: label.parent,
            viewpoint: at,
            arrive: label.arrive,
            depart: label.depart,
            score: self.rank(&label),
        });
        self.queue.push(Queued { depart: label.depart, label: index });
        self.labels.push(label);
        self.kept[at].push(index);
        if self.kept[at].len() > self.options.beam {
            self.trim_beam(at);
        }
        Some(index)
    }

    /// Drops the lowest-keyed labels, always sparing the earliest departure and the broadest
    /// coverage: those two have the most future.
    fn trim_beam(&mut self, at: usize) {
        let labels = &self.labels;
        let kept = &self.kept[at];
        let earliest = *kept
            .iter()
            .min_by(|&&a, &&b| {
                labels[a]
                    .depart
                    .total_cmp(&labels[b].depart)
                    .then(labels[b].score.total_cmp(&labels[a].score))
            })
            .expect("non-empty");
        // On a tie in coverage the earliest departure wins, so the two spared slots collapse
        // into one and the beam key decides one more label than it otherwise would.
        let broadest = *kept
            .iter()
            .max_by_key(|&&i| (self.preferred_of_field(&labels[i]), i == earliest))
            .expect("non-empty");
        let mut ranked: Vec<(usize, f64)> = std::mem::take(&mut self.kept[at])
            .into_iter()
            .map(|label| (label, self.beam_key(&self.labels[label])))
            .collect();
        ranked.sort_by(|&(x, key_x), &(y, key_y)| {
            let spared = |i| i == earliest || i == broadest;
            spared(y).cmp(&spared(x)).then(key_y.total_cmp(&key_x))
        });
        for (label, _) in ranked.split_off(self.options.beam) {
            self.labels[label].kill();
            self.record(LabelEvent::Trimmed { label });
        }
        self.kept[at] = ranked.into_iter().map(|(label, _)| label).collect();
    }

    fn record(&mut self, event: LabelEvent) {
        if self.options.trace {
            self.events.push(event);
            if self.events.len() >= EVENT_BATCH {
                self.flush();
            }
        }
    }

    fn flush(&mut self) {
        if !self.events.is_empty() {
            (self.sink)(std::mem::take(&mut self.events));
        }
    }

    fn dominated(&self, label: &Label) -> bool {
        self.kept[label.viewpoint].iter().any(|&i| dominates(&self.labels[i], label))
    }

    fn evict_dominated_by(&mut self, label: &Label) {
        let labels = &mut self.labels;
        let mut killed = Vec::new();
        self.kept[label.viewpoint].retain(|&i| {
            let beaten = dominates(label, &labels[i]);
            if beaten {
                labels[i].kill();
                killed.push(i);
            }
            !beaten
        });
        for i in killed {
            self.record(LabelEvent::Trimmed { label: i });
        }
    }

    fn can_still_finish(&self, label: &Label) -> bool {
        let problem = self.problem;
        let day_ok = problem.latest.is_none_or(|latest| label.depart <= latest);
        let end_ok = problem.end.is_none_or(|(end, latest)| {
            problem.travel[label.viewpoint][end].is_some_and(|t| label.depart + t <= latest)
        });
        day_ok && end_ok
    }

    fn expand(&mut self, index: usize) {
        let from = self.labels[index].viewpoint;
        let depart = self.labels[index].depart;
        for next in 0..self.problem.sightings.len() {
            if next == from {
                continue;
            }
            if let Some(travel) = self.problem.travel[from][next] {
                self.dwell(index, next, depart + travel);
            }
        }
    }

    /// One successor per useful leave time at `at`, having arrived there from `parent`.
    fn dwell(&mut self, parent: usize, at: usize, arrive: Seconds) {
        let sightings = &self.problem.sightings[at];
        // A window shutting the instant we arrive cannot be watched in full; this is also what
        // keeps every path's time strictly increasing when travel is free.
        let open: Vec<usize> = (0..sightings.len())
            .filter(|&i| sightings[i].window.open >= arrive && sightings[i].window.close > arrive)
            .collect();
        let mut leave_times: Vec<Seconds> = open
            .iter()
            .map(|&i| sightings[i].window.close.max(arrive + self.problem.min_stop))
            .collect();
        // Standing somewhere for no sighting only pays when it ticks off a required region.
        let region_here = self.problem.regions.iter().enumerate().any(|(i, r)| {
            r.inside.contains(at)
                && r.latest.is_none_or(|t| arrive <= t)
                && !self.labels[parent].regions_done.contains(i)
        });
        if region_here {
            leave_times.push(arrive + self.problem.min_stop);
        }
        leave_times.sort_by(f64::total_cmp);
        leave_times.dedup();
        for depart in leave_times {
            let newly_covered: Vec<usize> =
                open.iter().copied().filter(|&i| sightings[i].window.close <= depart).collect();
            if newly_covered.is_empty() && !region_here {
                continue;
            }
            let mut label = Label {
                viewpoint: at,
                arrive,
                depart,
                newly_covered: Vec::new(),
                parent: Some(parent),
                alive: true,
                ..self.labels[parent].clone()
            };
            for &i in &newly_covered {
                label.score += self.gain(&label, &sightings[i]);
                match sightings[i].kind {
                    Kind::Pass => {
                        label.seen[sightings[i].racer] =
                            label.seen[sightings[i].racer].saturating_add(1)
                    }
                    Kind::Finish => label.finished.insert(sightings[i].racer),
                }
            }
            label.newly_covered = newly_covered;
            label.visit_regions(self.problem);
            self.push(label);
        }
    }

    /// Marginal value of one more sighting given what this label has already seen; the last
    /// racer to complete a set earns that set's bonus on top.
    fn gain(&self, label: &Label, sighting: &Sighting) -> f64 {
        let racer = sighting.racer;
        let priority = self.problem.priorities[racer];
        let in_field = priority > 0.0;
        let w = &self.weights;
        let first = match sighting.kind {
            Kind::Finish => !label.finished.contains(racer),
            Kind::Pass => label.seen[racer] == 0,
        };
        if !first {
            return match sighting.kind {
                Kind::Finish => 0.0,
                Kind::Pass => {
                    priority
                        * w.repeat
                        * self.problem.objective.repeat_decay.powi(label.seen[racer] as i32)
                }
            };
        }
        let preferred = self.prefers(racer, sighting.kind);
        let en_route_only = self.problem.prefer[racer] == Prefer::EnRoute;
        let mut value = priority
            * match (preferred, sighting.kind) {
                (true, _) => w.preferred,
                // Worth less than the next pass would be: never preferred to seeing them run again.
                (false, Kind::Finish) if en_route_only => {
                    w.repeat
                        * self.problem.objective.repeat_decay.powi(label.seen[racer] as i32 + 1)
                }
                (false, _) => w.other,
            };
        if in_field && preferred && self.preferred_of_field(label) + 1 == self.field.len() {
            value += w.everyone_preferred;
        }
        if in_field
            && sighting.kind == Kind::Finish
            && self.finished_of_field(label) + 1 == self.field.len()
        {
            value += w.everyone_finished;
        }
        value
    }

    fn prefers(&self, racer: usize, kind: Kind) -> bool {
        match self.problem.prefer[racer] {
            Prefer::Finish => kind == Kind::Finish,
            Prefer::Neutral | Prefer::EnRoute => kind == Kind::Pass,
        }
    }

    fn had_preferred(&self, label: &Label, racer: usize) -> bool {
        match self.problem.prefer[racer] {
            Prefer::Finish => label.finished.contains(racer),
            Prefer::Neutral | Prefer::EnRoute => label.seen[racer] > 0,
        }
    }

    fn preferred_of_field(&self, label: &Label) -> usize {
        self.field.iter().filter(|&&r| self.had_preferred(label, r)).count()
    }

    fn finished_of_field(&self, label: &Label) -> usize {
        self.field.iter().filter(|&&r| label.finished.contains(r)).count()
    }

    /// Score with unmet requirements charged, which is what the plan is judged on: each
    /// required finish missed, then each required region missed, costs more than any level.
    fn rank(&self, label: &Label) -> f64 {
        let regions = (self.problem.regions.len() - label.regions_done.count_ones(..)) as f64;
        let finishes = (self.field.len() - self.finished_of_field(label)) as f64;
        label.score - self.weights.missed_finish * finishes - self.weights.missed_region * regions
    }

    /// What the beam keeps by: the rank plus credit for progress toward each completeness
    /// bonus, so a label one racer short of everyone is not squeezed out by one that merely
    /// hoards sightings of the other kind.
    fn beam_key(&self, label: &Label) -> f64 {
        let field = self.field.len() as f64;
        let credit = |done: usize, bonus: f64| {
            if (done as f64) < field { bonus * done as f64 / field } else { 0.0 }
        };
        self.rank(label)
            + credit(self.preferred_of_field(label), self.weights.everyone_preferred)
            + credit(self.finished_of_field(label), self.weights.everyone_finished)
    }

    fn best_plan(&self) -> Plan {
        let chosen = self.labels.iter().filter(|l| l.alive).max_by(|a, b| {
            self.rank(a).total_cmp(&self.rank(b)).then(b.depart.total_cmp(&a.depart))
        });
        let Some(chosen) = chosen else {
            return Plan {
                stops: Vec::new(),
                score: 0.0,
                unmet_regions: (0..self.problem.regions.len()).collect(),
            };
        };
        let mut stops: Vec<Stop> = Vec::new();
        let mut current = Some(chosen);
        while let Some(label) = current {
            // The root is a stop only when it is a start anchor the itinerary moves away from.
            let root = label.parent.is_none();
            let listed = stops.last().is_some_and(|s| s.viewpoint == label.viewpoint);
            if root && (self.problem.start.is_none() || listed) {
                break;
            }
            stops.push(Stop {
                viewpoint: label.viewpoint,
                arrive: label.arrive,
                depart: label.depart,
                sightings: label.newly_covered.clone(),
            });
            current = label.parent.map(|p| &self.labels[p]);
        }
        stops.reverse();
        if let Some((end, _)) = self.problem.end.filter(|&(end, _)| end != chosen.viewpoint) {
            let travel =
                self.problem.travel[chosen.viewpoint][end].expect("checked by can_still_finish");
            let arrive = chosen.depart + travel;
            stops.push(Stop { viewpoint: end, arrive, depart: arrive, sightings: Vec::new() });
        }
        let unmet_regions =
            (0..self.problem.regions.len()).filter(|&i| !chosen.regions_done.contains(i)).collect();
        Plan { stops, score: chosen.score, unmet_regions }
    }
}

#[cfg(test)]
mod tests {
    use birdseye_core::Window;

    use super::*;

    fn sighting(racer: usize, open: f64, close: f64) -> Sighting {
        Sighting {
            racer,
            window: Window { open, close },
            expected: (open + close) / 2.0,
            kind: Kind::Pass,
        }
    }

    fn finish(racer: usize, open: f64, close: f64) -> Sighting {
        Sighting { kind: Kind::Finish, ..sighting(racer, open, close) }
    }

    #[test]
    fn weights_separate_levels() {
        let objective = Objective::default();
        assert_eq!(
            level_base(&objective, 1, 1.0),
            20.0,
            "one racer, decay 0.5: at most 2 points per level, times ten"
        );
        let w = weights(&objective, 1, 1.0);
        assert_eq!(w.everyone_preferred, 160_000.0);
        assert_eq!(w.everyone_finished, 8_000.0);
        assert_eq!(w.preferred, 400.0);
        assert_eq!(w.other, 20.0);
        assert_eq!((w.repeat, w.missed_finish), (1.0, 0.0));
        assert_eq!(w.missed_region, 64_000_000.0);
        let required = weights(&Objective { require_finishes: true, ..objective }, 1, 1.0);
        assert_eq!((required.everyone_finished, required.missed_finish), (0.0, 3_200_000.0));
        assert_eq!(level_base(&objective, 30, 1.0), 600.0);
    }

    /// Two racers of priority 1 at decay 0.5 give a level of 40; both are neutral, so a first
    /// en-route sighting is the preferred kind and a finish the other.
    const FIRST: f64 = 40.0 * 40.0;
    const FINISH: f64 = 40.0;
    const EVERYONE: f64 = 40.0 * 40.0 * 40.0 * 40.0;

    /// Viewpoints in a line, ten seconds apart, spectator starting at 0; two racers of equal
    /// priority, so repeats are worth 0.5, 0.25, … on top of the constants above.
    fn line(sightings: Vec<Vec<Sighting>>) -> Problem {
        let n = sightings.len();
        let travel = (0..n)
            .map(|a| (0..n).map(|b| Some(10.0 * (a as f64 - b as f64).abs())).collect())
            .collect();
        Problem {
            sightings,
            travel,
            start: Some(0),
            earliest: 0.0,
            latest: None,
            end: None,
            min_stop: 0.0,
            priorities: vec![1.0, 1.0],
            prefer: vec![Prefer::Neutral, Prefer::Neutral],
            objective: Objective::default(),
            regions: Vec::new(),
        }
    }

    /// Every leg's duration is exactly the travel time between its stops.
    fn assert_consistent(plan: &Plan, problem: &Problem) {
        for pair in plan.stops.windows(2) {
            let travel = problem.travel[pair[0].viewpoint][pair[1].viewpoint].unwrap();
            assert_eq!(pair[1].arrive - pair[0].depart, travel, "{pair:?}");
        }
    }

    #[test]
    fn walks_alongside_a_single_racer_with_diminishing_returns() {
        let problem = line(vec![
            vec![],
            vec![sighting(0, 20.0, 25.0)],
            vec![sighting(0, 40.0, 45.0)],
            vec![sighting(0, 60.0, 65.0)],
        ]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, FIRST + 0.5 + 0.25);
        let visited: Vec<usize> = plan.stops.iter().map(|s| s.viewpoint).collect();
        assert_eq!(visited, vec![0, 1, 2, 3]);
        assert_consistent(&plan, &problem);
    }

    #[test]
    fn breadth_beats_depth() {
        // Camping at 1 sees racer 0 three times; going to 2 sees racer 1 once instead of the
        // third repeat.
        let problem = line(vec![
            vec![],
            vec![sighting(0, 10.0, 12.0), sighting(0, 20.0, 22.0), sighting(0, 40.0, 42.0)],
            vec![sighting(1, 35.0, 40.0)],
        ]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, EVERYONE + 2.0 * FIRST + 0.5);
        assert_eq!(plan.stops.last().unwrap().viewpoint, 2);
    }

    #[test]
    fn a_finish_beats_a_repeat() {
        let problem = line(vec![
            vec![],
            vec![sighting(0, 10.0, 12.0), sighting(0, 30.0, 32.0)],
            vec![finish(0, 25.0, 30.0)],
        ]);
        assert_eq!(plan(&problem, Options::default()).score, FIRST + FINISH);
    }

    #[test]
    fn preference_and_required_finishes_steer_between_exclusive_spots() {
        let mut problem = line(vec![
            vec![],
            vec![sighting(0, 10.0, 12.0), sighting(1, 12.0, 14.0)],
            vec![finish(0, 20.0, 21.0), finish(1, 21.0, 22.0)],
        ]);
        let en_route = plan(&problem, Options::default());
        assert_eq!(en_route.stops.last().unwrap().viewpoint, 1);
        assert_eq!(en_route.score, EVERYONE + 2.0 * FIRST);

        problem.prefer = vec![Prefer::Finish, Prefer::Finish];
        let finishes = plan(&problem, Options::default());
        assert_eq!(finishes.stops.last().unwrap().viewpoint, 2);
        assert_eq!(
            finishes.score,
            EVERYONE + FINISH * FINISH * FINISH + 2.0 * FIRST,
            "plus everyone finished"
        );

        problem.prefer = vec![Prefer::Neutral, Prefer::Neutral];
        problem.objective.require_finishes = true;
        let required = plan(&problem, Options::default());
        assert_eq!(required.stops.last().unwrap().viewpoint, 2, "missing a finish costs too much");
        assert_eq!(required.score, 2.0 * FINISH);
    }

    #[test]
    fn en_route_only_racers_rate_a_finish_like_a_repeat() {
        let mut problem = line(vec![
            vec![],
            vec![sighting(0, 10.0, 12.0), sighting(0, 30.0, 32.0)],
            vec![finish(0, 25.0, 30.0)],
        ]);
        problem.prefer[0] = Prefer::EnRoute;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.last().unwrap().viewpoint, 1, "stays for the repeat");
        assert_eq!(plan.score, FIRST + 0.5);
    }

    #[test]
    fn completing_the_field_outweighs_any_finish() {
        // Finishing racer 0 at 2 is worth 10 000; seeing racer 1 at 3 completes the field instead.
        let problem = line(vec![
            vec![],
            vec![sighting(0, 10.0, 12.0)],
            vec![finish(0, 25.0, 30.0)],
            vec![sighting(1, 35.0, 38.0)],
        ]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, EVERYONE + 2.0 * FIRST);
        assert_eq!(plan.stops.last().unwrap().viewpoint, 3);
    }

    #[test]
    fn start_anchor_with_sightings_is_one_stop() {
        let problem = line(vec![vec![sighting(0, 5.0, 6.0)], vec![]]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 1);
        assert_eq!(plan.stops[0].sightings, vec![0]);
    }

    #[test]
    fn a_narrow_beam_still_finds_the_whole_field() {
        // Finishing racer 0 over and over out-scores seeing racer 1 until the field completes;
        // the beam must keep the label that is one racer short of everyone.
        let mut hub = vec![sighting(0, 10.0, 12.0)];
        hub.extend((0..6).map(|i| finish(0, 20.0 + i as f64, 21.0 + i as f64)));
        let problem = line(vec![vec![], hub, vec![sighting(1, 45.0, 46.0)]]);
        let plan = plan(&problem, Options { beam: 1, ..Options::default() });
        assert!(plan.score >= EVERYONE, "{}", plan.score);
    }

    #[test]
    fn zero_priority_racers_do_not_gate_everyone() {
        let mut problem = line(vec![vec![], vec![sighting(0, 20.0, 25.0)]]);
        problem.priorities[1] = 0.0;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, EVERYONE + FIRST);
    }

    #[test]
    fn planner_picks_the_start_when_none_is_given() {
        let mut problem = line(vec![vec![], vec![], vec![sighting(0, 5.0, 6.0)]]);
        problem.start = None;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 1);
        assert_eq!(plan.stops[0].viewpoint, 2);
        assert_eq!(plan.score, FIRST);
    }

    #[test]
    fn required_region_pulls_the_route_and_is_reported_when_impossible() {
        let mut problem = line(vec![
            vec![],
            vec![sighting(0, 15.0, 20.0)],
            vec![sighting(1, 25.0, 30.0)],
            vec![sighting(1, 40.0, 45.0)],
        ]);
        let mut inside = FixedBitSet::with_capacity(4);
        inside.insert(3);
        problem.regions.push(Region { inside, latest: None });
        let met = plan(&problem, Options::default());
        assert!(met.unmet_regions.is_empty());
        assert_eq!(met.stops.last().unwrap().viewpoint, 3);

        problem.regions[0].latest = Some(1.0);
        let unmet = plan(&problem, Options::default());
        assert_eq!(unmet.unmet_regions, vec![0]);
        assert_eq!(unmet.score, EVERYONE + 2.0 * FIRST);
    }

    #[test]
    fn required_region_can_be_satisfied_by_just_standing_there() {
        let mut problem =
            line(vec![vec![], vec![sighting(0, 15.0, 20.0), sighting(1, 25.0, 30.0)], vec![]]);
        let mut inside = FixedBitSet::with_capacity(3);
        inside.insert(2);
        problem.regions.push(Region { inside, latest: None });
        let plan = plan(&problem, Options::default());
        assert!(plan.unmet_regions.is_empty());
        assert_eq!(plan.score, EVERYONE + 2.0 * FIRST);
        assert_eq!(plan.stops.last().unwrap().viewpoint, 2);
    }

    #[test]
    fn ending_where_the_last_sighting_was_adds_no_stop() {
        let mut problem = line(vec![vec![], vec![sighting(0, 20.0, 25.0)]]);
        problem.end = Some((1, 100.0));
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 2);
    }

    #[test]
    fn end_deadline_and_day_end_limit_the_wandering() {
        let mut problem =
            line(vec![vec![], vec![sighting(0, 20.0, 25.0)], vec![sighting(1, 100.0, 105.0)]]);
        problem.end = Some((0, 60.0));
        let anchored = plan(&problem, Options::default());
        assert_eq!(anchored.score, FIRST);
        assert_eq!(
            anchored.stops.last().unwrap(),
            &Stop { viewpoint: 0, arrive: 35.0, depart: 35.0, sightings: vec![] }
        );
        assert_consistent(&anchored, &problem);

        problem.end = None;
        problem.latest = Some(50.0);
        assert_eq!(plan(&problem, Options::default()).score, FIRST);
    }

    #[test]
    fn min_stop_delays_departure() {
        let mut problem = line(vec![vec![], vec![sighting(0, 20.0, 21.0)]]);
        problem.min_stop = 30.0;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops[1].depart, 40.0);
    }

    #[test]
    fn zero_length_windows_terminate() {
        let problem = line(vec![vec![], vec![sighting(0, 20.0, 20.0)]]);
        assert_eq!(plan(&problem, Options::default()).score, FIRST);
    }

    #[test]
    fn narrow_beam_keeps_the_early_departure() {
        let mut hub = vec![sighting(0, 10.0, 12.0)];
        hub.extend((0..5).map(|i| sighting(0, 20.0 + i as f64, 30.0 + i as f64)));
        let problem = line(vec![vec![], hub, vec![sighting(1, 25.0, 26.0)]]);
        let plan = plan(&problem, Options { beam: 1, ..Options::default() });
        assert_eq!(plan.score, EVERYONE + 2.0 * FIRST);
    }
}
