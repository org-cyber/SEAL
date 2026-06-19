module seal::agent_treasury {
    use std::string::{Self, String};
    use std::vector;
    use std::option::{Self, Option};
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::sui::SUI;
    use sui::event;
    use sui::clock::{Self, Clock};

    // ── ERRORS ────────────────────────────────────────────────────────────────

    const E_NOT_OWNER: u64 = 0;
    const E_INSUFFICIENT_BALANCE: u64 = 1;
    const E_AGENT_PAUSED: u64 = 2;
    const E_DAILY_CAP_EXCEEDED: u64 = 3;
    const E_MONTHLY_CAP_EXCEEDED: u64 = 4;
    const E_PROVIDER_NOT_APPROVED: u64 = 5;
    const E_SINGLE_TRANSFER_EXCEEDED: u64 = 6;
    const E_INVALID_PARENT: u64 = 7;
    const E_NO_BALANCE_TO_RECLAIM: u64 = 8;
    const E_ALREADY_PAUSED: u64 = 9;
    const E_NOT_PAUSED: u64 = 10;

    // ── CONSTANTS ────────────────────────────────────────────────────────────

    const MS_PER_DAY: u64 = 86_400_000;
    const MS_PER_MONTH: u64 = 2_592_000_000;

    // ── OBJECTS ─────────────────────────────────────────────────────────────

    public struct TreasuryOwnerCap has key, store {
        id: UID,
        treasury_id: ID,
    }

    public struct AgentTreasury has key {
        id: UID,
        owner: address,
        parent: Option<ID>,
        name: String,
        balance: Balance<SUI>,
        policy: PolicySet,
        spend_tracking: SpendTracking,
        reputation: Reputation,
        paused: bool,
        created_at: u64,
    }

    public struct PolicySet has store, drop {
        max_daily_spend: u64,
        max_monthly_spend: u64,
        max_single_spend: u64,
        approved_providers: vector<String>,
        velocity_threshold: u64,
    }

    public struct SpendTracking has store, drop {
        daily_spent: u64,
        monthly_spent: u64,
        last_daily_reset: u64,
        last_monthly_reset: u64,
    }

    public struct Reputation has store, drop {
        total_settled: u64,
        successful_calls: u64,
        violations: u64,
        anomaly_score: u64,
        last_active: u64,
    }

    // ── EVENTS ───────────────────────────────────────────────────────────────

    public struct AgentCreated has copy, drop {
        treasury_id: ID,
        owner: address,
        parent: Option<ID>,
        name: String,
        initial_budget: u64,
        created_at: u64,
    }

    public struct ChildSpawned has copy, drop {
        parent_id: ID,
        child_id: ID,
        owner: address,
        budget: u64,
        name: String,
    }

    public struct BudgetReclaimed has copy, drop {
        child_id: ID,
        parent_id: ID,
        amount: u64,
        timestamp: u64,
    }

    public struct AgentPaused has copy, drop {
        treasury_id: ID,
        reason: String,
        auto: bool,
        timestamp: u64,
    }

    public struct AgentResumed has copy, drop {
        treasury_id: ID,
        timestamp: u64,
    }

    public struct CallAuthorized has copy, drop {
        treasury_id: ID,
        cost: u64,
        provider: String,
        remaining_balance: u64,
        timestamp: u64,
    }

    public struct FundsDeposited has copy, drop {
        treasury_id: ID,
        amount: u64,
        source: String,
        timestamp: u64,
    }

    public struct FundsWithdrawn has copy, drop {
        treasury_id: ID,
        amount: u64,
        timestamp: u64,
    }

    // ── CONSTRUCTOR ──────────────────────────────────────────────────────────

    public fun create_master_treasury(
        payment: Coin<SUI>,
        name: String,
        policy: PolicySet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let budget = coin::into_balance(payment);
        let initial_amount = balance::value(&budget);
        let now = clock::timestamp_ms(clock);

        let treasury = AgentTreasury {
            id: object::new(ctx),
            owner,
            parent: option::none(),
            name,
            balance: budget,
            policy,
            spend_tracking: SpendTracking {
                daily_spent: 0,
                monthly_spent: 0,
                last_daily_reset: now,
                last_monthly_reset: now,
            },
            reputation: Reputation {
                total_settled: 0,
                successful_calls: 0,
                violations: 0,
                anomaly_score: 0,
                last_active: now,
            },
            paused: false,
            created_at: now,
        };

        let treasury_id = object::id(&treasury);

        let owner_cap = TreasuryOwnerCap {
            id: object::new(ctx),
            treasury_id,
        };

        event::emit(AgentCreated {
            treasury_id,
            owner,
            parent: option::none(),
            name,
            initial_budget: initial_amount,
            created_at: now,
        });

        transfer::public_transfer(owner_cap, owner);
        transfer::share_object(treasury);
    }

    // ── AGENT SPAWNING ───────────────────────────────────────────────────────

    public fun spawn_child_agent(
        parent_cap: &TreasuryOwnerCap,
        parent: &mut AgentTreasury,
        budget_amount: u64,
        name: String,
        child_policy: PolicySet,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::id(parent) == parent_cap.treasury_id, E_NOT_OWNER);
        assert!(!parent.paused, E_AGENT_PAUSED);
        
        let parent_balance = balance::value(&parent.balance);
        assert!(parent_balance >= budget_amount, E_INSUFFICIENT_BALANCE);

        reset_spend_tracking(&mut parent.spend_tracking, clock);

        let child_budget = balance::split(&mut parent.balance, budget_amount);
        let owner = parent.owner;
        let parent_id = option::some(object::id(parent));
        let now = clock::timestamp_ms(clock);

        let child = AgentTreasury {
            id: object::new(ctx),
            owner,
            parent: parent_id,
            name,
            balance: child_budget,
            policy: child_policy,
            spend_tracking: SpendTracking {
                daily_spent: 0,
                monthly_spent: 0,
                last_daily_reset: now,
                last_monthly_reset: now,
            },
            reputation: Reputation {
                total_settled: 0,
                successful_calls: 0,
                violations: 0,
                anomaly_score: 0,
                last_active: now,
            },
            paused: false,
            created_at: now,
        };

        let child_id = object::id(&child);
        
        let child_cap = TreasuryOwnerCap {
            id: object::new(ctx),
            treasury_id: child_id,
        };

        event::emit(ChildSpawned {
            parent_id: object::id(parent),
            child_id,
            owner,
            budget: budget_amount,
            name,
        });

        transfer::public_transfer(child_cap, owner);
        transfer::share_object(child);
    }

    // ── ATOMIC RECLAMATION ───────────────────────────────────────────────────

    public fun reclaim_child_budget(
        parent_cap: &TreasuryOwnerCap,
        parent: &mut AgentTreasury,
        child: AgentTreasury,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        assert!(object::id(parent) == parent_cap.treasury_id, E_NOT_OWNER);
        
        let child_id = object::id(&child);
        let child_balance_val = balance::value(&child.balance);
        
        let child_parent = child.parent;
        assert!(option::contains(&child_parent, &object::id(parent)), E_INVALID_PARENT);
        assert!(child_balance_val > 0, E_NO_BALANCE_TO_RECLAIM);

        let AgentTreasury {
            id,
            owner: _,
            parent: _,
            name: _,
            balance: child_budget,
            policy: _,
            spend_tracking: _,
            reputation: child_rep,
            paused: _,
            created_at: _,
        } = child;

        balance::join(&mut parent.balance, child_budget);
        
        parent.reputation.total_settled = parent.reputation.total_settled + child_rep.total_settled;
        parent.reputation.successful_calls = parent.reputation.successful_calls + child_rep.successful_calls;
        parent.reputation.violations = parent.reputation.violations + child_rep.violations;

        object::delete(id);

        event::emit(BudgetReclaimed {
            child_id,
            parent_id: object::id(parent),
            amount: child_balance_val,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // ── AUTHORIZE CALL (GATEWAY-ONLY) ───────────────────────────────────────

    public fun authorize_agent_call(
        agent: &mut AgentTreasury,
        gateway: address,
        cost: u64,
        provider: String,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(!agent.paused, E_AGENT_PAUSED);
        
        let now = clock::timestamp_ms(clock);
        
        reset_spend_tracking(&mut agent.spend_tracking, clock);

        assert!(vector::contains(&agent.policy.approved_providers, &provider), E_PROVIDER_NOT_APPROVED);
        assert!(cost <= agent.policy.max_single_spend, E_SINGLE_TRANSFER_EXCEEDED);
        
        let current_balance = balance::value(&agent.balance);
        assert!(current_balance >= cost, E_INSUFFICIENT_BALANCE);

        assert!(
            agent.spend_tracking.daily_spent + cost <= agent.policy.max_daily_spend,
            E_DAILY_CAP_EXCEEDED
        );

        assert!(
            agent.spend_tracking.monthly_spent + cost <= agent.policy.max_monthly_spend,
            E_MONTHLY_CAP_EXCEEDED
        );

        let spent = coin::from_balance(balance::split(&mut agent.balance, cost), ctx);
        transfer::public_transfer(spent, gateway);

        agent.spend_tracking.daily_spent = agent.spend_tracking.daily_spent + cost;
        agent.spend_tracking.monthly_spent = agent.spend_tracking.monthly_spent + cost;

        agent.reputation.total_settled = agent.reputation.total_settled + cost;
        agent.reputation.successful_calls = agent.reputation.successful_calls + 1;
        agent.reputation.last_active = now;

        if (cost > agent.policy.max_daily_spend / 2 && agent.policy.max_daily_spend > 0) {
            agent.reputation.anomaly_score = agent.reputation.anomaly_score + 20;
        };

        event::emit(CallAuthorized {
            treasury_id: object::id(agent),
            cost,
            provider,
            remaining_balance: balance::value(&agent.balance),
            timestamp: now,
        });
    }

    // ── PAUSE / RESUME ───────────────────────────────────────────────────────

    public fun pause_agent(
        cap: &TreasuryOwnerCap,
        treasury: &mut AgentTreasury,
        reason: String,
        auto: bool,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        assert!(object::id(treasury) == cap.treasury_id, E_NOT_OWNER);
        assert!(!treasury.paused, E_ALREADY_PAUSED);
        
        treasury.paused = true;
        
        event::emit(AgentPaused {
            treasury_id: object::id(treasury),
            reason,
            auto,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    public fun resume_agent(
        cap: &TreasuryOwnerCap,
        treasury: &mut AgentTreasury,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        assert!(object::id(treasury) == cap.treasury_id, E_NOT_OWNER);
        assert!(treasury.paused, E_NOT_PAUSED);
        
        treasury.paused = false;
        treasury.reputation.anomaly_score = 0;
        
        event::emit(AgentResumed {
            treasury_id: object::id(treasury),
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // ── MANUAL DEPOSIT / WITHDRAW ────────────────────────────────────────────

    public fun deposit(
        treasury: &mut AgentTreasury,
        payment: Coin<SUI>,
        source: String,
        clock: &Clock,
        _ctx: &mut TxContext
    ) {
        let amount = coin::value(&payment);
        balance::join(&mut treasury.balance, coin::into_balance(payment));
        
        event::emit(FundsDeposited {
            treasury_id: object::id(treasury),
            amount,
            source,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    public fun withdraw(
        cap: &TreasuryOwnerCap,
        treasury: &mut AgentTreasury,
        amount: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        assert!(object::id(treasury) == cap.treasury_id, E_NOT_OWNER);
        assert!(!treasury.paused, E_AGENT_PAUSED);
        assert!(balance::value(&treasury.balance) >= amount, E_INSUFFICIENT_BALANCE);

        let withdrawn = coin::from_balance(balance::split(&mut treasury.balance, amount), ctx);
        transfer::public_transfer(withdrawn, treasury.owner);

        event::emit(FundsWithdrawn {
            treasury_id: object::id(treasury),
            amount,
            timestamp: clock::timestamp_ms(clock),
        });
    }

    // ── POLICY UPDATE ────────────────────────────────────────────────────────

    public fun update_policy(
        cap: &TreasuryOwnerCap,
        treasury: &mut AgentTreasury,
        new_policy: PolicySet,
        _ctx: &mut TxContext
    ) {
        assert!(object::id(treasury) == cap.treasury_id, E_NOT_OWNER);
        treasury.policy = new_policy;
    }

    // ── GETTERS ──────────────────────────────────────────────────────────────

    public fun get_balance(treasury: &AgentTreasury): u64 {
        balance::value(&treasury.balance)
    }

    public fun is_paused(treasury: &AgentTreasury): bool {
        treasury.paused
    }

    public fun get_policy(treasury: &AgentTreasury): &PolicySet {
        &treasury.policy
    }

    public fun get_spend_tracking(treasury: &AgentTreasury): &SpendTracking {
        &treasury.spend_tracking
    }

    public fun get_reputation(treasury: &AgentTreasury): &Reputation {
        &treasury.reputation
    }

    public fun get_parent(treasury: &AgentTreasury): &Option<ID> {
        &treasury.parent
    }

    public fun get_owner(treasury: &AgentTreasury): address {
        treasury.owner
    }

    public fun get_name(treasury: &AgentTreasury): &String {
        &treasury.name
    }

    // ── POLICY SET HELPERS ───────────────────────────────────────────────────

    public fun create_policy(
        max_daily_spend: u64,
        max_monthly_spend: u64,
        max_single_spend: u64,
        approved_providers: vector<String>,
        velocity_threshold: u64,
    ): PolicySet {
        PolicySet {
            max_daily_spend,
            max_monthly_spend,
            max_single_spend,
            approved_providers,
            velocity_threshold,
        }
    }

    public fun policy_daily_cap(policy: &PolicySet): u64 { policy.max_daily_spend }
    public fun policy_monthly_cap(policy: &PolicySet): u64 { policy.max_monthly_spend }
    public fun policy_single_cap(policy: &PolicySet): u64 { policy.max_single_spend }
    public fun policy_providers(policy: &PolicySet): &vector<String> { &policy.approved_providers }
    public fun policy_velocity(policy: &PolicySet): u64 { policy.velocity_threshold }

    // ── INTERNAL HELPERS ─────────────────────────────────────────────────────

    fun reset_spend_tracking(spend: &mut SpendTracking, clock: &Clock) {
        let now = clock::timestamp_ms(clock);
        
        if (now - spend.last_daily_reset >= MS_PER_DAY) {
            spend.daily_spent = 0;
            spend.last_daily_reset = now;
        };
        
        if (now - spend.last_monthly_reset >= MS_PER_MONTH) {
            spend.monthly_spent = 0;
            spend.last_monthly_reset = now;
        };
    }
}