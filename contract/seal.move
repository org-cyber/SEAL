module 0x6e1de9eee9168dbf4803abf85fa955c0047111c8572ff74a3e47d3983bd61fd4::seal_api_pool {
    struct AdminCap has store, key {
        id: 0x2::object::UID,
    }
    
    struct ProviderCapRecord has store {
        daily_cap: u64,
        daily_spent: u64,
        window_start: u64,
    }
    
    struct MemberRecord has store {
        daily_cap: u64,
        daily_spent: u64,
        daily_window_start: u64,
        total_spent: u64,
        call_count: u64,
    }
    
    struct TeamRecord has store {
        admin: address,
        team_balance: u64,
        team_daily_cap: u64,
        team_daily_spent: u64,
        team_daily_window_start: u64,
        team_monthly_cap: u64,
        team_monthly_spent: u64,
        team_monthly_window_start: u64,
        members: 0x2::table::Table<address, MemberRecord>,
        total_deposited: u64,
        total_spent: u64,
        call_count: u64,
        created_at: u64,
    }
    
    struct WalletRecord has store {
        balance: u64,
        total_spent: u64,
        daily_cap: u64,
        monthly_cap: u64,
        daily_spent: u64,
        monthly_spent: u64,
        daily_window_start: u64,
        monthly_window_start: u64,
        call_count: u64,
        created_at: u64,
        provider_caps: 0x2::table::Table<vector<u8>, ProviderCapRecord>,
        paused: bool,
        low_balance_threshold: u64,
    }
    
    struct SealAPIPool has key {
        id: 0x2::object::UID,
        treasury: 0x2::coin::Coin<0x2::sui::SUI>,
        wallet_records: 0x2::table::Table<address, WalletRecord>,
        teams: 0x2::table::Table<address, TeamRecord>,
        authorized_gateways: 0x2::table::Table<address, bool>,
        protocol_wallet: address,
        total_deposited: u64,
        total_disbursed: u64,
        total_fees_collected: u64,
        wallet_count: u64,
        team_count: u64,
        total_calls: u64,
    }
    
    struct DepositEvent has copy, drop {
        wallet: address,
        amount: u64,
        new_balance: u64,
        source: vector<u8>,
        timestamp: u64,
    }
    
    struct WithdrawEvent has copy, drop {
        wallet: address,
        amount: u64,
        remaining_balance: u64,
        timestamp: u64,
    }
    
    struct SpendCapsSetEvent has copy, drop {
        wallet: address,
        daily_cap: u64,
        monthly_cap: u64,
        timestamp: u64,
    }
    
    struct ProviderCapSetEvent has copy, drop {
        wallet: address,
        provider: vector<u8>,
        daily_cap: u64,
        timestamp: u64,
    }
    
    struct ApiCallReceiptEvent has copy, drop {
        wallet: address,
        cost: u64,
        fee: u64,
        provider: vector<u8>,
        model_name: vector<u8>,
        tokens_used: u64,
        request_hash: vector<u8>,
        remaining_balance: u64,
        daily_spent: u64,
        monthly_spent: u64,
        timestamp: u64,
        wallet_call_number: u64,
        is_team_call: bool,
    }
    
    struct LowBalanceAlertEvent has copy, drop {
        wallet: address,
        current_balance: u64,
        threshold: u64,
        timestamp: u64,
    }
    
    struct WalletPauseEvent has copy, drop {
        wallet: address,
        paused: bool,
        timestamp: u64,
    }
    
    struct TeamCreatedEvent has copy, drop {
        team_id: address,
        admin: address,
        initial_balance: u64,
        timestamp: u64,
    }
    
    struct TeamMemberAddedEvent has copy, drop {
        team_id: address,
        member: address,
        daily_cap: u64,
        timestamp: u64,
    }
    
    struct TeamCallReceiptEvent has copy, drop {
        team_id: address,
        member: address,
        cost: u64,
        provider: vector<u8>,
        model_name: vector<u8>,
        tokens_used: u64,
        team_remaining_balance: u64,
        member_daily_spent: u64,
        member_daily_cap: u64,
        timestamp: u64,
    }
    
    struct GatewayAddedEvent has copy, drop {
        gateway: address,
        timestamp: u64,
    }
    
    struct GatewayRemovedEvent has copy, drop {
        gateway: address,
        timestamp: u64,
    }
    
    struct ProtocolWalletUpdatedEvent has copy, drop {
        old_wallet: address,
        new_wallet: address,
        timestamp: u64,
    }
    
    public entry fun add_gateway(arg0: &AdminCap, arg1: &mut SealAPIPool, arg2: address, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        assert!(!0x2::table::contains<address, bool>(&arg1.authorized_gateways, arg2), 7);
        0x2::table::add<address, bool>(&mut arg1.authorized_gateways, arg2, true);
        let v0 = GatewayAddedEvent{
            gateway   : arg2, 
            timestamp : 0x2::clock::timestamp_ms(arg3),
        };
        0x2::event::emit<GatewayAddedEvent>(v0);
    }
    
    public entry fun add_team_member(arg0: &mut SealAPIPool, arg1: address, arg2: address, arg3: u64, arg4: &0x2::clock::Clock, arg5: &mut 0x2::tx_context::TxContext) {
        assert!(0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1), 20);
        let v0 = 0x2::table::borrow_mut<address, TeamRecord>(&mut arg0.teams, arg1);
        assert!(v0.admin == 0x2::tx_context::sender(arg5), 16);
        assert!(!0x2::table::contains<address, MemberRecord>(&v0.members, arg2), 17);
        let v1 = 0x2::clock::timestamp_ms(arg4);
        let v2 = MemberRecord{
            daily_cap          : arg3, 
            daily_spent        : 0, 
            daily_window_start : v1, 
            total_spent        : 0, 
            call_count         : 0,
        };
        0x2::table::add<address, MemberRecord>(&mut v0.members, arg2, v2);
        let v3 = TeamMemberAddedEvent{
            team_id   : arg1, 
            member    : arg2, 
            daily_cap : arg3, 
            timestamp : v1,
        };
        0x2::event::emit<TeamMemberAddedEvent>(v3);
    }
    
    public entry fun authorize_call(arg0: &mut SealAPIPool, arg1: address, arg2: u64, arg3: vector<u8>, arg4: address, arg5: vector<u8>, arg6: vector<u8>, arg7: u64, arg8: &0x2::clock::Clock, arg9: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg9);
        assert!(0x2::table::contains<address, bool>(&arg0.authorized_gateways, v0) && *0x2::table::borrow<address, bool>(&arg0.authorized_gateways, v0), 6);
        assert!(arg2 > 0, 12);
        assert!(0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1), 5);
        let v1 = 0x2::clock::timestamp_ms(arg8);
        let v2 = 0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, arg1);
        assert!(!v2.paused, 14);
        if (v1 >= v2.daily_window_start + 86400000) {
            v2.daily_spent = 0;
            v2.daily_window_start = v1;
        };
        if (v1 >= v2.monthly_window_start + 2592000000) {
            v2.monthly_spent = 0;
            v2.monthly_window_start = v1;
        };
        assert!(v2.balance >= arg2, 2);
        if (v2.daily_cap > 0 && v2.daily_spent + arg2 > v2.daily_cap) {
            abort 3
        } else {
            if (v2.monthly_cap > 0 && v2.monthly_spent + arg2 > v2.monthly_cap) {
                abort 4
            } else {
                if (0x2::table::contains<vector<u8>, ProviderCapRecord>(&v2.provider_caps, arg3)) {
                    let v3 = 0x2::table::borrow_mut<vector<u8>, ProviderCapRecord>(&mut v2.provider_caps, arg3);
                    if (v1 >= v3.window_start + 86400000) {
                        v3.daily_spent = 0;
                        v3.window_start = v1;
                    };
                    if (v3.daily_cap > 0 && v3.daily_spent + arg2 > v3.daily_cap) {
                        abort 15
                    };
                    v3.daily_spent = v3.daily_spent + arg2;
                };
                let v4 = arg2 * 100 / 10000;
                let v5 = arg2 - v4;
                v2.balance = v2.balance - arg2;
                v2.total_spent = v2.total_spent + arg2;
                v2.daily_spent = v2.daily_spent + arg2;
                v2.monthly_spent = v2.monthly_spent + arg2;
                v2.call_count = v2.call_count + 1;
                let v6 = v2.balance;
                let v7 = v2.low_balance_threshold;
                let v8 = 0x2::coin::split<0x2::sui::SUI>(&mut arg0.treasury, arg2, arg9);
                0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(0x2::coin::split<0x2::sui::SUI>(&mut v8, v5, arg9), arg4);
                0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(v8, arg0.protocol_wallet);
                arg0.total_disbursed = arg0.total_disbursed + v5;
                arg0.total_fees_collected = arg0.total_fees_collected + v4;
                arg0.total_calls = arg0.total_calls + 1;
                if (v7 > 0 && v6 < v7) {
                    let v9 = LowBalanceAlertEvent{
                        wallet          : arg1, 
                        current_balance : v6, 
                        threshold       : v7, 
                        timestamp       : v1,
                    };
                    0x2::event::emit<LowBalanceAlertEvent>(v9);
                };
                let v10 = ApiCallReceiptEvent{
                    wallet             : arg1, 
                    cost               : v5, 
                    fee                : v4, 
                    provider           : arg3, 
                    model_name         : arg6, 
                    tokens_used        : arg7, 
                    request_hash       : arg5, 
                    remaining_balance  : v6, 
                    daily_spent        : v2.daily_spent, 
                    monthly_spent      : v2.monthly_spent, 
                    timestamp          : v1, 
                    wallet_call_number : v2.call_count, 
                    is_team_call       : false,
                };
                0x2::event::emit<ApiCallReceiptEvent>(v10);
                return
                abort 15
            };
        };
    }
    
    public entry fun authorize_team_call(arg0: &mut SealAPIPool, arg1: address, arg2: address, arg3: u64, arg4: vector<u8>, arg5: address, arg6: vector<u8>, arg7: vector<u8>, arg8: u64, arg9: &0x2::clock::Clock, arg10: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg10);
        assert!(0x2::table::contains<address, bool>(&arg0.authorized_gateways, v0) && *0x2::table::borrow<address, bool>(&arg0.authorized_gateways, v0), 6);
        assert!(arg3 > 0, 12);
        assert!(0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1), 20);
        let v1 = 0x2::clock::timestamp_ms(arg9);
        let v2 = 0x2::table::borrow_mut<address, TeamRecord>(&mut arg0.teams, arg1);
        assert!(0x2::table::contains<address, MemberRecord>(&v2.members, arg2), 18);
        if (v1 >= v2.team_daily_window_start + 86400000) {
            v2.team_daily_spent = 0;
            v2.team_daily_window_start = v1;
        };
        if (v1 >= v2.team_monthly_window_start + 2592000000) {
            v2.team_monthly_spent = 0;
            v2.team_monthly_window_start = v1;
        };
        assert!(v2.team_balance >= arg3, 2);
        if (v2.team_daily_cap > 0 && v2.team_daily_spent + arg3 > v2.team_daily_cap) {
            abort 19
        };
        if (v2.team_monthly_cap > 0 && v2.team_monthly_spent + arg3 > v2.team_monthly_cap) {
            abort 19
        };
        let v3 = 0x2::table::borrow_mut<address, MemberRecord>(&mut v2.members, arg2);
        if (v1 >= v3.daily_window_start + 86400000) {
            v3.daily_spent = 0;
            v3.daily_window_start = v1;
        };
        if (v3.daily_cap > 0 && v3.daily_spent + arg3 > v3.daily_cap) {
            abort 21
        };
        let v4 = arg3 * 100 / 10000;
        let v5 = arg3 - v4;
        v2.team_balance = v2.team_balance - arg3;
        v2.team_daily_spent = v2.team_daily_spent + arg3;
        v2.team_monthly_spent = v2.team_monthly_spent + arg3;
        v2.total_spent = v2.total_spent + arg3;
        v2.call_count = v2.call_count + 1;
        v3.daily_spent = v3.daily_spent + arg3;
        v3.total_spent = v3.total_spent + arg3;
        v3.call_count = v3.call_count + 1;
        let v6 = v2.team_balance;
        let v7 = v3.daily_spent;
        let v8 = 0x2::coin::split<0x2::sui::SUI>(&mut arg0.treasury, arg3, arg10);
        0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(0x2::coin::split<0x2::sui::SUI>(&mut v8, v5, arg10), arg5);
        0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(v8, arg0.protocol_wallet);
        arg0.total_disbursed = arg0.total_disbursed + v5;
        arg0.total_fees_collected = arg0.total_fees_collected + v4;
        arg0.total_calls = arg0.total_calls + 1;
        if (v6 < arg3 * 10) {
            let v9 = LowBalanceAlertEvent{
                wallet          : arg1, 
                current_balance : v6, 
                threshold       : arg3 * 10, 
                timestamp       : v1,
            };
            0x2::event::emit<LowBalanceAlertEvent>(v9);
        };
        let v10 = TeamCallReceiptEvent{
            team_id                : arg1, 
            member                 : arg2, 
            cost                   : v5, 
            provider               : arg4, 
            model_name             : arg7, 
            tokens_used            : arg8, 
            team_remaining_balance : v6, 
            member_daily_spent     : v7, 
            member_daily_cap       : v3.daily_cap, 
            timestamp              : v1,
        };
        0x2::event::emit<TeamCallReceiptEvent>(v10);
        let v11 = ApiCallReceiptEvent{
            wallet             : arg2, 
            cost               : v5, 
            fee                : v4, 
            provider           : arg4, 
            model_name         : arg7, 
            tokens_used        : arg8, 
            request_hash       : arg6, 
            remaining_balance  : v6, 
            daily_spent        : v7, 
            monthly_spent      : 0, 
            timestamp          : v1, 
            wallet_call_number : v3.call_count, 
            is_team_call       : true,
        };
        0x2::event::emit<ApiCallReceiptEvent>(v11);
    }
    
    public entry fun create_team(arg0: &mut SealAPIPool, arg1: 0x2::coin::Coin<0x2::sui::SUI>, arg2: u64, arg3: u64, arg4: &0x2::clock::Clock, arg5: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg5);
        assert!(!0x2::table::contains<address, TeamRecord>(&arg0.teams, v0), 22);
        let v1 = 0x2::coin::value<0x2::sui::SUI>(&arg1);
        assert!(v1 > 0, 1);
        let v2 = 0x2::clock::timestamp_ms(arg4);
        0x2::coin::join<0x2::sui::SUI>(&mut arg0.treasury, arg1);
        let v3 = TeamRecord{
            admin                     : v0, 
            team_balance              : v1, 
            team_daily_cap            : arg2, 
            team_daily_spent          : 0, 
            team_daily_window_start   : v2, 
            team_monthly_cap          : arg3, 
            team_monthly_spent        : 0, 
            team_monthly_window_start : v2, 
            members                   : 0x2::table::new<address, MemberRecord>(arg5), 
            total_deposited           : v1, 
            total_spent               : 0, 
            call_count                : 0, 
            created_at                : v2,
        };
        0x2::table::add<address, TeamRecord>(&mut arg0.teams, v0, v3);
        arg0.total_deposited = arg0.total_deposited + v1;
        arg0.team_count = arg0.team_count + 1;
        let v4 = TeamCreatedEvent{
            team_id         : v0, 
            admin           : v0, 
            initial_balance : v1, 
            timestamp       : v2,
        };
        0x2::event::emit<TeamCreatedEvent>(v4);
    }
    
    public entry fun deposit(arg0: &mut SealAPIPool, arg1: 0x2::coin::Coin<0x2::sui::SUI>, arg2: &0x2::clock::Clock, arg3: &mut 0x2::tx_context::TxContext) {
        deposit_with_source(arg0, arg1, b"unknown", arg2, arg3);
    }
    
    public entry fun deposit_to_team(arg0: &mut SealAPIPool, arg1: address, arg2: 0x2::coin::Coin<0x2::sui::SUI>, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::coin::value<0x2::sui::SUI>(&arg2);
        assert!(v0 > 0, 1);
        assert!(0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1), 20);
        let v1 = 0x2::table::borrow_mut<address, TeamRecord>(&mut arg0.teams, arg1);
        assert!(v1.admin == 0x2::tx_context::sender(arg4), 16);
        0x2::coin::join<0x2::sui::SUI>(&mut arg0.treasury, arg2);
        v1.team_balance = v1.team_balance + v0;
        v1.total_deposited = v1.total_deposited + v0;
        arg0.total_deposited = arg0.total_deposited + v0;
        let v2 = DepositEvent{
            wallet      : arg1, 
            amount      : v0, 
            new_balance : v1.team_balance, 
            source      : b"team_topup", 
            timestamp   : 0x2::clock::timestamp_ms(arg3),
        };
        0x2::event::emit<DepositEvent>(v2);
    }
    
    public entry fun deposit_with_source(arg0: &mut SealAPIPool, arg1: 0x2::coin::Coin<0x2::sui::SUI>, arg2: vector<u8>, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::coin::value<0x2::sui::SUI>(&arg1);
        assert!(v0 > 0, 1);
        let v1 = 0x2::tx_context::sender(arg4);
        let v2 = 0x2::clock::timestamp_ms(arg3);
        0x2::coin::join<0x2::sui::SUI>(&mut arg0.treasury, arg1);
        ensure_wallet(arg0, v1, v2, arg4);
        let v3 = 0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v1);
        v3.balance = v3.balance + v0;
        arg0.total_deposited = arg0.total_deposited + v0;
        let v4 = DepositEvent{
            wallet      : v1, 
            amount      : v0, 
            new_balance : v3.balance, 
            source      : arg2, 
            timestamp   : v2,
        };
        0x2::event::emit<DepositEvent>(v4);
    }
    
    fun ensure_wallet(arg0: &mut SealAPIPool, arg1: address, arg2: u64, arg3: &mut 0x2::tx_context::TxContext) {
        if (!0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)) {
            let v0 = WalletRecord{
                balance               : 0, 
                total_spent           : 0, 
                daily_cap             : 0, 
                monthly_cap           : 0, 
                daily_spent           : 0, 
                monthly_spent         : 0, 
                daily_window_start    : arg2, 
                monthly_window_start  : arg2, 
                call_count            : 0, 
                created_at            : arg2, 
                provider_caps         : 0x2::table::new<vector<u8>, ProviderCapRecord>(arg3), 
                paused                : false, 
                low_balance_threshold : 0,
            };
            0x2::table::add<address, WalletRecord>(&mut arg0.wallet_records, arg1, v0);
            arg0.wallet_count = arg0.wallet_count + 1;
        };
    }
    
    public fun get_balance(arg0: &SealAPIPool, arg1: address) : u64 {
        if (!0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)) {
            return 0
        };
        0x2::table::borrow<address, WalletRecord>(&arg0.wallet_records, arg1).balance
    }
    
    public fun get_member_stats(arg0: &SealAPIPool, arg1: address, arg2: address) : (u64, u64, u64) {
        if (!0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1)) {
            return (0, 0, 0)
        };
        let v0 = 0x2::table::borrow<address, TeamRecord>(&arg0.teams, arg1);
        if (!0x2::table::contains<address, MemberRecord>(&v0.members, arg2)) {
            return (0, 0, 0)
        };
        let v1 = 0x2::table::borrow<address, MemberRecord>(&v0.members, arg2);
        (v1.daily_cap, v1.daily_spent, v1.total_spent)
    }
    
    public fun get_pool_stats(arg0: &SealAPIPool) : (u64, u64, u64, u64, u64, u64) {
        (arg0.total_deposited, arg0.total_disbursed, arg0.total_fees_collected, arg0.wallet_count, arg0.team_count, arg0.total_calls)
    }
    
    public fun get_pool_treasury_balance(arg0: &SealAPIPool) : u64 {
        0x2::coin::value<0x2::sui::SUI>(&arg0.treasury)
    }
    
    public fun get_protocol_wallet(arg0: &SealAPIPool) : address {
        arg0.protocol_wallet
    }
    
    public fun get_spend_status(arg0: &SealAPIPool, arg1: address) : (u64, u64, u64, u64) {
        if (!0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)) {
            return (0, 0, 0, 0)
        };
        let v0 = 0x2::table::borrow<address, WalletRecord>(&arg0.wallet_records, arg1);
        (v0.daily_cap, v0.daily_spent, v0.monthly_cap, v0.monthly_spent)
    }
    
    public fun get_team_balance(arg0: &SealAPIPool, arg1: address) : u64 {
        if (!0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1)) {
            return 0
        };
        0x2::table::borrow<address, TeamRecord>(&arg0.teams, arg1).team_balance
    }
    
    public fun get_team_stats(arg0: &SealAPIPool, arg1: address) : (u64, u64, u64) {
        if (!0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1)) {
            return (0, 0, 0)
        };
        let v0 = 0x2::table::borrow<address, TeamRecord>(&arg0.teams, arg1);
        (v0.team_balance, v0.total_spent, v0.call_count)
    }
    
    public fun get_wallet_stats(arg0: &SealAPIPool, arg1: address) : (u64, u64, u64) {
        if (!0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)) {
            return (0, 0, 0)
        };
        let v0 = 0x2::table::borrow<address, WalletRecord>(&arg0.wallet_records, arg1);
        (v0.total_spent, v0.call_count, v0.created_at)
    }
    
    fun init(arg0: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg0);
        let v1 = SealAPIPool{
            id                   : 0x2::object::new(arg0), 
            treasury             : 0x2::coin::zero<0x2::sui::SUI>(arg0), 
            wallet_records       : 0x2::table::new<address, WalletRecord>(arg0), 
            teams                : 0x2::table::new<address, TeamRecord>(arg0), 
            authorized_gateways  : 0x2::table::new<address, bool>(arg0), 
            protocol_wallet      : v0, 
            total_deposited      : 0, 
            total_disbursed      : 0, 
            total_fees_collected : 0, 
            wallet_count         : 0, 
            team_count           : 0, 
            total_calls          : 0,
        };
        0x2::transfer::share_object<SealAPIPool>(v1);
        let v2 = AdminCap{id: 0x2::object::new(arg0)};
        0x2::transfer::transfer<AdminCap>(v2, v0);
    }
    
    public fun is_gateway(arg0: &SealAPIPool, arg1: address) : bool {
        if (!0x2::table::contains<address, bool>(&arg0.authorized_gateways, arg1)) {
            return false
        };
        *0x2::table::borrow<address, bool>(&arg0.authorized_gateways, arg1)
    }
    
    public fun is_wallet_paused(arg0: &SealAPIPool, arg1: address) : bool {
        if (!0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)) {
            return false
        };
        0x2::table::borrow<address, WalletRecord>(&arg0.wallet_records, arg1).paused
    }
    
    public fun is_wallet_registered(arg0: &SealAPIPool, arg1: address) : bool {
        0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, arg1)
    }
    
    public entry fun pause_wallet(arg0: &mut SealAPIPool, arg1: &0x2::clock::Clock, arg2: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg2);
        let v1 = 0x2::clock::timestamp_ms(arg1);
        ensure_wallet(arg0, v0, v1, arg2);
        0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0).paused = true;
        let v2 = WalletPauseEvent{
            wallet    : v0, 
            paused    : true, 
            timestamp : v1,
        };
        0x2::event::emit<WalletPauseEvent>(v2);
    }
    
    public entry fun remove_gateway(arg0: &AdminCap, arg1: &mut SealAPIPool, arg2: address, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        assert!(0x2::table::contains<address, bool>(&arg1.authorized_gateways, arg2), 13);
        *0x2::table::borrow_mut<address, bool>(&mut arg1.authorized_gateways, arg2) = false;
        let v0 = GatewayRemovedEvent{
            gateway   : arg2, 
            timestamp : 0x2::clock::timestamp_ms(arg3),
        };
        0x2::event::emit<GatewayRemovedEvent>(v0);
    }
    
    public entry fun set_low_balance_threshold(arg0: &mut SealAPIPool, arg1: u64, arg2: &0x2::clock::Clock, arg3: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg3);
        ensure_wallet(arg0, v0, 0x2::clock::timestamp_ms(arg2), arg3);
        0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0).low_balance_threshold = arg1;
    }
    
    public entry fun set_provider_cap(arg0: &mut SealAPIPool, arg1: vector<u8>, arg2: u64, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg4);
        let v1 = 0x2::clock::timestamp_ms(arg3);
        ensure_wallet(arg0, v0, v1, arg4);
        let v2 = 0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0);
        if (0x2::table::contains<vector<u8>, ProviderCapRecord>(&v2.provider_caps, arg1)) {
            0x2::table::borrow_mut<vector<u8>, ProviderCapRecord>(&mut v2.provider_caps, arg1).daily_cap = arg2;
        } else {
            let v3 = ProviderCapRecord{
                daily_cap    : arg2, 
                daily_spent  : 0, 
                window_start : v1,
            };
            0x2::table::add<vector<u8>, ProviderCapRecord>(&mut v2.provider_caps, arg1, v3);
        };
        let v4 = ProviderCapSetEvent{
            wallet    : v0, 
            provider  : arg1, 
            daily_cap : arg2, 
            timestamp : v1,
        };
        0x2::event::emit<ProviderCapSetEvent>(v4);
    }
    
    public entry fun set_spend_caps(arg0: &mut SealAPIPool, arg1: u64, arg2: u64, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg4);
        let v1 = 0x2::clock::timestamp_ms(arg3);
        ensure_wallet(arg0, v0, v1, arg4);
        let v2 = 0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0);
        v2.daily_cap = arg1;
        v2.monthly_cap = arg2;
        let v3 = SpendCapsSetEvent{
            wallet      : v0, 
            daily_cap   : arg1, 
            monthly_cap : arg2, 
            timestamp   : v1,
        };
        0x2::event::emit<SpendCapsSetEvent>(v3);
    }
    
    public entry fun unpause_wallet(arg0: &mut SealAPIPool, arg1: &0x2::clock::Clock, arg2: &mut 0x2::tx_context::TxContext) {
        let v0 = 0x2::tx_context::sender(arg2);
        let v1 = 0x2::clock::timestamp_ms(arg1);
        ensure_wallet(arg0, v0, v1, arg2);
        0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0).paused = false;
        let v2 = WalletPauseEvent{
            wallet    : v0, 
            paused    : false, 
            timestamp : v1,
        };
        0x2::event::emit<WalletPauseEvent>(v2);
    }
    
    public entry fun update_protocol_wallet(arg0: &AdminCap, arg1: &mut SealAPIPool, arg2: address, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        arg1.protocol_wallet = arg2;
        let v0 = ProtocolWalletUpdatedEvent{
            old_wallet : arg1.protocol_wallet, 
            new_wallet : arg2, 
            timestamp  : 0x2::clock::timestamp_ms(arg3),
        };
        0x2::event::emit<ProtocolWalletUpdatedEvent>(v0);
    }
    
    public entry fun withdraw(arg0: &mut SealAPIPool, arg1: u64, arg2: &0x2::clock::Clock, arg3: &mut 0x2::tx_context::TxContext) {
        assert!(arg1 > 0, 9);
        let v0 = 0x2::tx_context::sender(arg3);
        assert!(0x2::table::contains<address, WalletRecord>(&arg0.wallet_records, v0), 5);
        let v1 = 0x2::table::borrow_mut<address, WalletRecord>(&mut arg0.wallet_records, v0);
        assert!(v1.balance >= arg1, 10);
        v1.balance = v1.balance - arg1;
        0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(0x2::coin::split<0x2::sui::SUI>(&mut arg0.treasury, arg1, arg3), v0);
        let v2 = WithdrawEvent{
            wallet            : v0, 
            amount            : arg1, 
            remaining_balance : v1.balance, 
            timestamp         : 0x2::clock::timestamp_ms(arg2),
        };
        0x2::event::emit<WithdrawEvent>(v2);
    }
    
    public entry fun withdraw_from_team(arg0: &mut SealAPIPool, arg1: address, arg2: u64, arg3: &0x2::clock::Clock, arg4: &mut 0x2::tx_context::TxContext) {
        assert!(arg2 > 0, 9);
        let v0 = 0x2::tx_context::sender(arg4);
        assert!(0x2::table::contains<address, TeamRecord>(&arg0.teams, arg1), 20);
        let v1 = 0x2::table::borrow_mut<address, TeamRecord>(&mut arg0.teams, arg1);
        assert!(v1.admin == v0, 16);
        assert!(v1.team_balance >= arg2, 10);
        v1.team_balance = v1.team_balance - arg2;
        0x2::transfer::public_transfer<0x2::coin::Coin<0x2::sui::SUI>>(0x2::coin::split<0x2::sui::SUI>(&mut arg0.treasury, arg2, arg4), v0);
        let v2 = WithdrawEvent{
            wallet            : arg1, 
            amount            : arg2, 
            remaining_balance : v1.team_balance, 
            timestamp         : 0x2::clock::timestamp_ms(arg3),
        };
        0x2::event::emit<WithdrawEvent>(v2);
    }
    
    // decompiled from Move bytecode v6
}


