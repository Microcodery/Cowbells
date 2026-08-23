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

use birdeye_core::{Objective, Seconds, Tier};
use fixedbitset::FixedBitSet;

use crate::viewpoints::{Kind, Viewpoint};

#[derive(Debug, Clone)]
pub struct Problem {
    pub viewpoints: Vec<Viewpoint>,
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
    pub objective: Objective,
    pub regions: Vec<Region>,
}

/// A required region resolved onto viewpoints.
#[derive(Debug, Clone)]
pub struct Region {
    pub inside: FixedBitSet,
    pub latest: Option<Seconds>,
}

/// Objective weights resolved for this field of racers.
struct Weights {
    en_route: f64,
    finish: f64,
    /// Missing a required region costs more than a whole tier could earn.
    region_penalty: f64,
}

impl Weights {
    fn for_problem(problem: &Problem) -> Self {
        let objective = &problem.objective;
        let racers = problem.priorities.len();
        let max_priority = problem.priorities.iter().cloned().fold(0.0, f64::max);
        let top = objective.weight(objective.tiers[0], racers, max_priority);
        Self {
            en_route: objective.weight(Tier::EnRoute, racers, max_priority),
            finish: objective.weight(Tier::Finish, racers, max_priority),
            region_penalty: top * objective.tier_base(racers, max_priority),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Labels kept per viewpoint; more is slower and closer to optimal.
    pub beam: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { beam: 64 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stop {
    pub viewpoint: usize,
    pub arrive: Seconds,
    pub depart: Seconds,
    /// Indices into `viewpoints[viewpoint].sightings`.
    pub sightings: Vec<usize>,
}

/// Raw solver output referencing viewpoints and sightings by index; `Itinerary` is the rendered form.
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
    let mut search = Search {
        problem,
        options,
        weights: Weights::for_problem(problem),
        labels: Vec::new(),
        kept: vec![Vec::new(); problem.viewpoints.len()],
        queue: BinaryHeap::new(),
    };
    let roots: Vec<usize> = match problem.start {
        Some(start) => vec![start],
        None => (0..problem.viewpoints.len()).collect(),
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

/// `a` leaves no later, scores no less, and has at least as much left to gain.
fn dominates(a: &Label, b: &Label) -> bool {
    a.depart <= b.depart
        && a.score >= b.score
        && a.seen.iter().zip(&b.seen).all(|(x, y)| x <= y)
        && a.finished.is_subset(&b.finished)
        && a.regions_done.is_superset(&b.regions_done)
}

struct Search<'a> {
    problem: &'a Problem,
    options: Options,
    weights: Weights,
    labels: Vec<Label>,
    /// Surviving label indices per viewpoint, for dominance and the beam.
    kept: Vec<Vec<usize>>,
    queue: BinaryHeap<Queued>,
}

impl Search<'_> {
    /// Keeps the label unless it is dominated, hopeless, or squeezed out by the beam.
    fn push(&mut self, label: Label) -> Option<usize> {
        if self.dominated(&label) || !self.can_still_finish(&label) {
            return None;
        }
        let index = self.labels.len();
        let at = label.viewpoint;
        self.evict_dominated_by(&label);
        self.queue.push(Queued { depart: label.depart, label: index });
        self.labels.push(label);
        self.kept[at].push(index);
        if self.kept[at].len() > self.options.beam {
            self.trim_beam(at);
        }
        Some(index)
    }

    /// Drops the lowest-scoring labels, always sparing the earliest departure: it has the most future.
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
        let ranks: Vec<f64> = kept.iter().map(|&i| self.rank(&labels[i])).collect();
        let mut order: Vec<usize> = (0..kept.len()).collect();
        order.sort_by(|&x, &y| {
            (kept[y] == earliest).cmp(&(kept[x] == earliest)).then(ranks[y].total_cmp(&ranks[x]))
        });
        let survivors: Vec<usize> =
            order.iter().take(self.options.beam).map(|&x| kept[x]).collect();
        for &dropped in order.iter().skip(self.options.beam).map(|x| &kept[*x]) {
            self.labels[dropped].kill();
        }
        self.kept[at] = survivors;
    }

    fn dominated(&self, label: &Label) -> bool {
        self.kept[label.viewpoint].iter().any(|&i| dominates(&self.labels[i], label))
    }

    fn evict_dominated_by(&mut self, label: &Label) {
        let labels = &mut self.labels;
        self.kept[label.viewpoint].retain(|&i| {
            let beaten = dominates(label, &labels[i]);
            if beaten {
                labels[i].kill();
            }
            !beaten
        });
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
        for next in 0..self.problem.viewpoints.len() {
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
        let sightings = &self.problem.viewpoints[at].sightings;
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

    /// Marginal value of one more sighting given what this label has already seen.
    fn gain(&self, label: &Label, sighting: &crate::viewpoints::Sighting) -> f64 {
        let priority = self.problem.priorities[sighting.racer];
        let value = match sighting.kind {
            Kind::Finish if !label.finished.contains(sighting.racer) => self.weights.finish,
            Kind::Finish => 0.0,
            Kind::Pass => {
                let repeats = label.seen[sighting.racer] as i32;
                self.weights.en_route * self.problem.objective.repeat_decay.powi(repeats)
            }
        };
        priority * value
    }

    /// Score with unmet required regions charged, which is what the plan is judged on.
    fn rank(&self, label: &Label) -> f64 {
        let unmet = (self.problem.regions.len() - label.regions_done.count_ones(..)) as f64;
        label.score - self.weights.region_penalty * unmet
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
        let mut stops = Vec::new();
        let mut current = Some(chosen);
        while let Some(label) = current {
            // The root is a stop only when it is a start anchor the itinerary moves away from.
            let root = label.parent.is_none();
            let listed = stops.last().is_some_and(|s: &Stop| s.viewpoint == label.viewpoint);
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
    use birdeye_core::Window;
    use birdeye_core::geom::Point;

    use super::*;
    use crate::viewpoints::Sighting;

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

    fn viewpoint(node: usize, sightings: Vec<Sighting>) -> Viewpoint {
        Viewpoint { node, point: Point::new(node as f64, 0.0), arcs: Vec::new(), sightings }
    }

    /// Viewpoints in a line, ten seconds apart, spectator starting at 0; two racers of equal priority.
    fn line(viewpoints: Vec<Viewpoint>) -> Problem {
        let n = viewpoints.len();
        let travel = (0..n)
            .map(|a| (0..n).map(|b| Some(10.0 * (a as f64 - b as f64).abs())).collect())
            .collect();
        Problem {
            viewpoints,
            travel,
            start: Some(0),
            earliest: 0.0,
            latest: None,
            end: None,
            min_stop: 0.0,
            priorities: vec![1.0, 1.0],
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
            viewpoint(0, vec![]),
            viewpoint(1, vec![sighting(0, 20.0, 25.0)]),
            viewpoint(2, vec![sighting(0, 40.0, 45.0)]),
            viewpoint(3, vec![sighting(0, 60.0, 65.0)]),
        ]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, 100.0 + 50.0 + 25.0);
        let visited: Vec<usize> = plan.stops.iter().map(|s| s.viewpoint).collect();
        assert_eq!(visited, vec![0, 1, 2, 3]);
        assert_consistent(&plan, &problem);
    }

    #[test]
    fn breadth_beats_depth() {
        // Camping at 1 sees racer 0 three times; going to 2 sees racer 1 once instead of the third repeat.
        let problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(
                1,
                vec![sighting(0, 10.0, 12.0), sighting(0, 20.0, 22.0), sighting(0, 40.0, 42.0)],
            ),
            viewpoint(2, vec![sighting(1, 35.0, 40.0)]),
        ]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.score, 100.0 + 50.0 + 100.0);
        assert_eq!(plan.stops.last().unwrap().viewpoint, 2);
    }

    #[test]
    fn tier_order_decides_repeat_versus_finish() {
        let mut problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, vec![sighting(0, 10.0, 12.0), sighting(0, 30.0, 32.0)]),
            viewpoint(2, vec![finish(0, 25.0, 30.0)]),
        ]);
        assert_eq!(plan(&problem, Options::default()).score, 100.0 + 50.0, "en-route tier first");
        problem.objective.tiers = vec![Tier::Finish, Tier::EnRoute];
        assert_eq!(plan(&problem, Options::default()).score, 1.0 + 100.0, "finish tier first");
    }

    #[test]
    fn start_anchor_with_sightings_is_one_stop() {
        let problem = line(vec![viewpoint(0, vec![sighting(0, 5.0, 6.0)]), viewpoint(1, vec![])]);
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 1);
        assert_eq!(plan.stops[0].sightings, vec![0]);
    }

    #[test]
    fn planner_picks_the_start_when_none_is_given() {
        let mut problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, vec![]),
            viewpoint(2, vec![sighting(0, 5.0, 6.0)]),
        ]);
        problem.start = None;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 1);
        assert_eq!(plan.stops[0].viewpoint, 2);
        assert_eq!(plan.score, 100.0);
    }

    #[test]
    fn required_region_pulls_the_route_and_is_reported_when_impossible() {
        let mut problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, vec![sighting(0, 15.0, 20.0)]),
            viewpoint(2, vec![sighting(1, 25.0, 30.0)]),
            viewpoint(3, vec![sighting(1, 40.0, 45.0)]),
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
        assert_eq!(unmet.score, 200.0);
    }

    #[test]
    fn required_region_can_be_satisfied_by_just_standing_there() {
        let mut problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, vec![sighting(0, 15.0, 20.0), sighting(1, 25.0, 30.0)]),
            viewpoint(2, vec![]),
        ]);
        let mut inside = FixedBitSet::with_capacity(3);
        inside.insert(2);
        problem.regions.push(Region { inside, latest: None });
        let plan = plan(&problem, Options::default());
        assert!(plan.unmet_regions.is_empty());
        assert_eq!(plan.score, 200.0);
        assert_eq!(plan.stops.last().unwrap().viewpoint, 2);
    }

    #[test]
    fn ending_where_the_last_sighting_was_adds_no_stop() {
        let mut problem =
            line(vec![viewpoint(0, vec![]), viewpoint(1, vec![sighting(0, 20.0, 25.0)])]);
        problem.end = Some((1, 100.0));
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops.len(), 2);
    }

    #[test]
    fn end_deadline_and_day_end_limit_the_wandering() {
        let mut problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, vec![sighting(0, 20.0, 25.0)]),
            viewpoint(2, vec![sighting(1, 100.0, 105.0)]),
        ]);
        problem.end = Some((0, 60.0));
        let anchored = plan(&problem, Options::default());
        assert_eq!(anchored.score, 100.0);
        assert_eq!(
            anchored.stops.last().unwrap(),
            &Stop { viewpoint: 0, arrive: 35.0, depart: 35.0, sightings: vec![] }
        );
        assert_consistent(&anchored, &problem);

        problem.end = None;
        problem.latest = Some(50.0);
        assert_eq!(plan(&problem, Options::default()).score, 100.0);
    }

    #[test]
    fn min_stop_delays_departure() {
        let mut problem =
            line(vec![viewpoint(0, vec![]), viewpoint(1, vec![sighting(0, 20.0, 21.0)])]);
        problem.min_stop = 30.0;
        let plan = plan(&problem, Options::default());
        assert_eq!(plan.stops[1].depart, 40.0);
    }

    #[test]
    fn zero_length_windows_terminate() {
        let problem = line(vec![viewpoint(0, vec![]), viewpoint(1, vec![sighting(0, 20.0, 20.0)])]);
        assert_eq!(plan(&problem, Options::default()).score, 100.0);
    }

    #[test]
    fn narrow_beam_keeps_the_early_departure() {
        let mut hub = vec![sighting(0, 10.0, 12.0)];
        hub.extend((0..5).map(|i| sighting(0, 20.0 + i as f64, 30.0 + i as f64)));
        let problem = line(vec![
            viewpoint(0, vec![]),
            viewpoint(1, hub),
            viewpoint(2, vec![sighting(1, 25.0, 26.0)]),
        ]);
        let plan = plan(&problem, Options { beam: 1 });
        assert_eq!(plan.score, 200.0);
    }
}
