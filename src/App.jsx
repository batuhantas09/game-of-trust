import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, serverTimestamp, doc, updateDoc, increment, writeBatch, getDocs, deleteDoc } from 'firebase/firestore';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, LineController } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, LineController);

// --- Firebase Configuration (Vite-compatible) ---
let firebaseConfig;
let appId = 'default-app-id';

try {
    if (typeof import.meta.env !== 'undefined' && import.meta.env.VITE_FIREBASE_CONFIG) {
        // Priority 1: Vite environment (your local machine / Vercel)
        firebaseConfig = JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG);
    } else if (typeof __firebase_config !== 'undefined' && __firebase_config) {
        // Priority 2: Interactive environment (like this one)
        firebaseConfig = JSON.parse(__firebase_config);
    } else {
        // Fallback
        console.warn("Firebase config not found. Using fallback.");
        firebaseConfig = {}; 
    }
    if (firebaseConfig.appId) {
        appId = firebaseConfig.appId;
    }
} catch (error) {
    console.error("Error parsing Firebase config:", error);
    firebaseConfig = {};
}


// --- Firebase Initialization ---
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- Game Logic & Constants ---
const CONDITIONS = {
    'opponent_last_move': "Opponent's last move is",
    'your_last_move': "Your last move is",
    'opponent_nth_last_move': "Opponent's Nth last move is",
    'your_nth_last_move': "Your Nth last move is",
    'opponent_most_common': "Opponent's most common move is",
    'your_most_common': "Your most common move is",
};
const MOVES = { 'Betray': 'Betray', 'Cooperate': 'Cooperate' };
const ACTIONS = { 'Betray': 'Betray', 'Cooperate': 'Cooperate', 'Random': 'Random' };
const PREDEFINED_STRATEGIES = {
    alwaysCooperate: (my, opp) => 'Cooperate', alwaysBetray: (my, opp) => 'Betray',
    random: (my, opp) => Math.random() < 0.5 ? 'Cooperate' : 'Betray',
    titForTat: (my, opp) => opp.length === 0 ? 'Cooperate' : opp[opp.length - 1],
    grudger: (my, opp) => opp.includes('Betray') ? 'Betray' : 'Cooperate'
};
const PAYOFFS = { 'Cooperate-Cooperate': {p1:1,p2:1}, 'Betray-Betray': {p1:0,p2:0}, 'Cooperate-Betray': {p1:0,p2:2}, 'Betray-Cooperate': {p1:2,p2:0} };
const INTERPRETER_HELPERS = {
    getLastMove: (h) => h.length > 0 ? h[h.length - 1] : 'Cooperate',
    getNthLastMove: (h, n) => h.length >= n ? h[h.length - n] : 'Cooperate',
    getMostCommonMove: (h) => {
        if (h.length === 0) return 'Cooperate';
        const counts = h.reduce((acc, m) => { acc[m] = (acc[m] || 0) + 1; return acc; }, {});
        return counts.Betray > counts.Cooperate ? 'Betray' : 'Cooperate';
    }
};

// --- Interpreter Functions ---
function evaluateCondition(condition, myHistory, opponentHistory) {
    let subjectMove;
    switch(condition.type) {
        case 'opponent_last_move': subjectMove = INTERPRETER_HELPERS.getLastMove(opponentHistory); break;
        case 'your_last_move': subjectMove = INTERPRETER_HELPERS.getLastMove(myHistory); break;
        case 'opponent_nth_last_move': subjectMove = INTERPRETER_HELPERS.getNthLastMove(opponentHistory, condition.n_value); break;
        case 'your_nth_last_move': subjectMove = INTERPRETER_HELPERS.getNthLastMove(myHistory, condition.n_value); break;
        case 'opponent_most_common': subjectMove = INTERPRETER_HELPERS.getMostCommonMove(opponentHistory); break;
        case 'your_most_common': subjectMove = INTERPRETER_HELPERS.getMostCommonMove(myHistory); break;
        default: return false;
    }
    return subjectMove === condition.value;
}

function createStrategyFromLogicTree(logicTree) {
    return (myHistory, opponentHistory) => {
        for (const clause of logicTree) {
            let isClauseTrue = false;
            if (clause.type === 'IF' || clause.type === 'ELSEIF') {
                if (clause.conditions.length === 0) isClauseTrue = false;
                else if (clause.matchType === 'AND') isClauseTrue = clause.conditions.every(c => evaluateCondition(c, myHistory, opponentHistory));
                else isClauseTrue = clause.conditions.some(c => evaluateCondition(c, myHistory, opponentHistory));
            } else if (clause.type === 'ELSE') {
                isClauseTrue = true;
            }

            if (isClauseTrue) {
                if (clause.action === 'Random') return PREDEFINED_STRATEGIES.random();
                return clause.action;
            }
        }
        return 'Cooperate';
    };
}


// --- React Components ---

const Clause = ({ clause, onUpdate, onRemove, isFirst, hasElse }) => {
    const handleConditionChange = (index, updatedCondition) => {
        const newConditions = [...clause.conditions];
        newConditions[index] = updatedCondition;
        onUpdate({ ...clause, conditions: newConditions });
    };
    const addCondition = () => {
        const newConditions = [...clause.conditions, { type: 'opponent_last_move', value: 'Betray', n_value: 1 }];
        onUpdate({ ...clause, conditions: newConditions });
    };
    const removeCondition = (index) => {
        const newConditions = clause.conditions.filter((_, i) => i !== index);
        onUpdate({ ...clause, conditions: newConditions });
    };
    const handleTypeChange = (e) => {
        const newType = e.target.value;
        if (newType === 'ELSE' && hasElse) {
            alert("Only one ELSE clause is allowed.");
            return;
        }
        onUpdate({ ...clause, type: newType });
    };

    return (
        <div className="logic-clause bg-gray-700 p-4 rounded-lg space-y-3">
            <div className="clause-header flex justify-between items-center">
                <select value={clause.type} onChange={handleTypeChange} disabled={isFirst} className="clause-type text-xl font-bold text-cyan-400 bg-transparent border-0 focus:ring-0 disabled:bg-gray-700 disabled:text-cyan-400">
                    <option value="IF">IF</option> <option value="ELSEIF">ELSEIF</option> <option value="ELSE">ELSE</option>
                </select>
                {clause.type !== 'ELSE' && (
                     <div className="flex items-center space-x-4">
                        <div className="flex items-center">
                            <span className="text-sm mr-2 text-gray-300">Match:</span>
                            <select value={clause.matchType} onChange={(e) => onUpdate({...clause, matchType: e.target.value})} className="match-type bg-gray-600 border border-gray-500 rounded-md p-1 text-sm">
                                <option value="AND">ALL (AND)</option> <option value="OR">ANY (OR)</option>
                            </select>
                        </div>
                        <button onClick={addCondition} className="add-condition bg-cyan-800 hover:bg-cyan-700 text-white font-bold py-1 px-3 rounded-md text-sm">+ Add</button>
                    </div>
                )}
                {!isFirst && <button onClick={onRemove} className="remove-clause text-red-400 hover:text-red-600 font-bold text-2xl">&times;</button>}
            </div>
            {clause.type !== 'ELSE' && (
                <div className="conditions-container space-y-2">
                    {clause.conditions.map((cond, index) => (
                        <div key={index} className="condition-row grid grid-cols-12 gap-2 items-center">
                            <div className="col-span-1"></div>
                            <select value={cond.type} onChange={(e) => handleConditionChange(index, {...cond, type: e.target.value})} className="condition col-span-5 bg-gray-600 border border-gray-500 rounded p-2">
                                {Object.entries(CONDITIONS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
                            </select>
                            <div className="value-container col-span-5 flex gap-2 items-center">
                                <input type="number" min="1" value={cond.n_value || 1} onChange={(e) => handleConditionChange(index, {...cond, n_value: parseInt(e.target.value) || 1})} className={`value-number w-1/4 bg-gray-500 border-gray-400 rounded p-2 text-center ${cond.type.includes('nth_last_move') ? '' : 'hidden'}`} placeholder="N"/>
                                <select value={cond.value} onChange={(e) => handleConditionChange(index, {...cond, value: e.target.value})} className="value-move w-full bg-gray-500 border-gray-400 rounded p-2">
                                    {Object.entries(MOVES).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
                                </select>
                            </div>
                            <button onClick={() => removeCondition(index)} className="remove-condition col-span-1 text-red-400 hover:text-red-600 font-bold text-xl">&times;</button>
                        </div>
                    ))}
                </div>
            )}
            <div className="then-action-container flex items-center">
                <span className="text-lg font-bold text-blue-400 mr-4">{clause.type === 'ELSE' ? 'ACTION' : 'THEN'}</span>
                <select value={clause.action} onChange={(e) => onUpdate({...clause, action: e.target.value})} className="then-action action-select flex-grow bg-blue-600 border border-blue-500 rounded p-2">
                    {Object.entries(ACTIONS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}
                </select>
            </div>
        </div>
    );
};

const LogicBuilder = ({ userId, allStrategies, runTournamentOnSave }) => {
    const [logicName, setLogicName] = useState('');
    const [authorName, setAuthorName] = useState('');
    const [clauses, setClauses] = useState([{ type: 'IF', conditions: [{ type: 'opponent_last_move', value: 'Betray', n_value: 1 }], matchType: 'AND', action: 'Betray' }]);
    const [isSaving, setIsSaving] = useState(false);
    
    const updateClause = (index, updatedClause) => setClauses(clauses.map((c, i) => i === index ? updatedClause : c));
    const addClause = () => !clauses.some(c => c.type === 'ELSE') && setClauses([...clauses, { type: 'ELSEIF', conditions: [{ type: 'opponent_last_move', value: 'Betray', n_value: 1 }], matchType: 'AND', action: 'Cooperate' }]);
    const removeClause = (index) => setClauses(clauses.filter((_, i) => i !== index));

    const handleSaveToDatabase = async () => {
        if (!logicName.trim() || isSaving) return;
        if (!userId) { alert('Authentication error.'); return; }
        setIsSaving(true);
        const displayName = authorName.trim() || `User-${userId.substring(0, 6)}`;
        const logicToSave = { name: logicName, authorDisplayName: displayName, clauses: clauses, authorId: userId, createdAt: serverTimestamp(), score: 0 };
        try {
            const strategiesCollection = collection(db, `artifacts/${appId}/public/data/strategies`);
            const docRef = await addDoc(strategiesCollection, logicToSave);
            alert(`Logic "${logicName}" saved! Running tournament...`);
            const newStrategyWithId = { ...logicToSave, id: docRef.id };
            await runTournamentOnSave(newStrategyWithId, allStrategies);
            alert("Tournament complete! Check Arena & Match Logs.");
        } catch (error) {
            console.error("Error during save/tournament: ", error);
            alert("Failed to save or run tournament.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="w-full max-w-5xl mx-auto bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8">
            <h2 className="text-3xl md:text-4xl font-bold text-center mb-2 text-cyan-400">Strategy Builder</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 my-6">
                <input type="text" value={logicName} onChange={(e) => setLogicName(e.target.value)} placeholder="Enter Your Logic Name" className="bg-gray-700 border border-gray-600 text-white rounded-lg p-3"/>
                <input type="text" value={authorName} onChange={(e) => setAuthorName(e.target.value)} placeholder="Author Name (Optional)" className="bg-gray-700 border border-gray-600 text-white rounded-lg p-3"/>
            </div>
            <div className="flex justify-center mb-6">
                 <button onClick={handleSaveToDatabase} disabled={isSaving} className="bg-green-600 hover:bg-green-700 disabled:bg-gray-500 text-white font-bold py-3 px-8 rounded-lg shadow-md">
                    {isSaving ? 'Saving & Running Tournament...' : 'Save to Arena & Compete'}
                </button>
            </div>
            <div id="clauses-container" className="space-y-4 mb-4">
                {clauses.map((clause, index) => <Clause key={index} clause={clause} onUpdate={(c) => updateClause(index, c)} onRemove={() => removeClause(index)} isFirst={index===0} hasElse={clauses.some(c => c.type === 'ELSE')} />)}
            </div>
            {!clauses.some(c => c.type === 'ELSE') && <button onClick={addClause} className="bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded-lg shadow-md">+ Add Logic Clause</button>}
        </div>
    );
};

const MoveHistoryVisualizer = ({ moves }) => (
    <div className="flex flex-row flex-nowrap gap-px">
        {moves.map((move, index) => (
            <div key={index} className={`w-3 h-3 rounded-sm ${move === 'Cooperate' ? 'bg-green-500' : 'bg-red-500'}`} title={`Round ${index + 1}: ${move}`}></div>
        ))}
    </div>
);

const MatchLogs = ({ logs }) => (
    <div className="w-full max-w-5xl mx-auto bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-6 text-cyan-400">Match Logs</h2>
        <div className="space-y-4">
            {logs.length === 0 && <p className="text-center text-gray-500">No matches played yet.</p>}
            {logs.map(log => (
                <div key={log.id} className="bg-gray-700 p-4 rounded-lg">
                    <div className="flex justify-between items-center mb-3">
                        <div className="font-bold text-lg">{log.s1_name} <span className="text-gray-400">vs</span> {log.s2_name}</div>
                        <div className="font-mono text-lg">{log.s1_score} - {log.s2_score}</div>
                    </div>
                    <div className="space-y-1">
                        <MoveHistoryVisualizer moves={log.s1_moves} />
                        <MoveHistoryVisualizer moves={log.s2_moves} />
                    </div>
                </div>
            ))}
        </div>
    </div>
);

const Arena = ({ strategies, onRunTournament, isTournamentRunning }) => {
    const [timeLeft, setTimeLeft] = useState('');

    useEffect(() => {
        const timer = setInterval(() => {
            const now = new Date();
            const nextHour = new Date(now);
            nextHour.setHours(now.getHours() + 1);
            nextHour.setMinutes(0, 0, 0);
            const diff = Math.round((nextHour.getTime() - now.getTime()) / 1000);

            if (diff <= 1 && !isTournamentRunning) {
                setTimeLeft('00:00');
                onRunTournament();
            } else if (!isTournamentRunning) {
                const minutes = Math.floor(diff / 60);
                const seconds = diff % 60;
                setTimeLeft(`${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
            }
        }, 1000);

        return () => clearInterval(timer);
    }, [onRunTournament, isTournamentRunning]);

    return (
        <div className="w-full max-w-5xl mx-auto bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8">
            <div className="text-center mb-6">
                <h2 className="text-3xl md:text-4xl font-bold text-cyan-400">The Arena</h2>
                <p className="text-gray-400 mt-2">Leaderboard of all competing strategies.</p>
                <div className="mt-4 bg-gray-900/50 p-4 rounded-lg inline-block">
                    <p className="text-lg text-gray-300">Next tournament starts in:</p>
                    <p className="text-4xl font-mono font-bold text-purple-400">
                        {isTournamentRunning ? 'In Progress...' : timeLeft}
                    </p>
                </div>
            </div>
            <div className="space-y-4">
                {strategies.map(strategy => (
                    <div key={strategy.id} className="bg-gray-700 p-4 rounded-lg flex justify-between items-center">
                        <div>
                            <h3 className="text-xl font-bold text-white">{strategy.name}</h3>
                            <p className="text-sm text-gray-400">by {strategy.authorDisplayName || `User-${strategy.authorId.substring(0,6)}`}</p>
                        </div>
                        <div className="text-right">
                             <span className="text-2xl font-bold text-green-400">{strategy.score}</span>
                             <p className="text-sm text-gray-400">Points</p>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const AdminPanel = ({ onRunTournament, onResetScores, onClearArena, isRunning }) => {
    const [confirmResetScores, setConfirmResetScores] = useState(false);
    const [confirmClearArena, setConfirmClearArena] = useState(false);

    const handleResetScores = () => {
        if (confirmResetScores) {
            onResetScores();
            setConfirmResetScores(false);
        } else {
            setConfirmResetScores(true);
        }
    };
    
    const handleClearArena = () => {
        if (confirmClearArena) {
            onClearArena();
            setConfirmClearArena(false);
        } else {
            setConfirmClearArena(true);
        }
    };

    return (
        <div className="fixed bottom-4 right-4 bg-gray-900/80 backdrop-blur-sm border border-cyan-500 p-4 rounded-lg shadow-lg z-50">
            <h3 className="text-lg font-bold text-cyan-400 mb-4">Admin Panel</h3>
            <div className="flex flex-col gap-3">
                <button onClick={onRunTournament} disabled={isRunning} className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-500 text-white font-bold py-2 px-4 rounded-lg">
                    {isRunning ? 'Running...' : 'Run Grand Tournament'}
                </button>
                <button onClick={handleResetScores} onMouseLeave={() => setConfirmResetScores(false)} disabled={isRunning} className={`font-bold py-2 px-4 rounded-lg ${confirmResetScores ? 'bg-yellow-700 hover:bg-yellow-800' : 'bg-yellow-500 hover:bg-yellow-600'} disabled:bg-gray-500`}>
                    {confirmResetScores ? 'Are you sure?' : 'Reset Scores'}
                </button>
                <button onClick={handleClearArena} onMouseLeave={() => setConfirmClearArena(false)} disabled={isRunning} className={`font-bold py-2 px-4 rounded-lg ${confirmClearArena ? 'bg-red-700 hover:bg-red-800' : 'bg-red-500 hover:bg-red-600'} disabled:bg-gray-500`}>
                    {confirmClearArena ? 'Confirm Clear Arena?' : 'Clear Arena (Reset All)'}
                </button>
            </div>
        </div>
    );
};

const AdminLoginModal = ({ onLogin, onClose }) => {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = (e) => {
        e.preventDefault();
        if (onLogin(password)) {
            // Success, parent will close
        } else {
            setError('Incorrect password.');
            setPassword('');
        }
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 p-8 rounded-lg shadow-xl border border-cyan-500">
                <h2 className="text-2xl font-bold text-center mb-4 text-cyan-400">Admin Login</h2>
                <form onSubmit={handleSubmit}>
                    <input 
                        type="password" 
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg p-3 mb-4"
                        placeholder="Password"
                    />
                    {error && <p className="text-red-500 text-center mb-4">{error}</p>}
                    <div className="flex gap-4">
                        <button type="button" onClick={onClose} className="w-full bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded-lg">Cancel</button>
                        <button type="submit" className="w-full bg-cyan-600 hover:bg-cyan-700 text-white font-bold py-2 px-4 rounded-lg">Login</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

// NEW DEBUG COMPONENT
const VercelDebugInfo = () => {
    if (typeof import.meta.env !== 'undefined' && import.meta.env.PROD) {
        const configValue = import.meta.env.VITE_FIREBASE_CONFIG || "NOT SET";
        let parsedStatus = "Not attempted";
        let parsedAppId = "N/A";
        try {
            const parsed = JSON.parse(configValue);
            parsedStatus = "Successfully Parsed";
            parsedAppId = parsed.appId || "Not found in object";
        } catch (e) {
            parsedStatus = `Failed to parse: ${e.message}`;
        }

        return (
            <div style={{ position: 'fixed', bottom: '50px', left: '10px', backgroundColor: 'rgba(0,0,0,0.8)', color: 'white', padding: '10px', borderRadius: '5px', zIndex: 1000, fontSize: '12px', border: '1px solid red' }}>
                <h4>Vercel Debug Info</h4>
                <p><strong>VITE_FIREBASE_CONFIG:</strong> <code style={{ wordBreak: 'break-all' }}>{configValue}</code></p>
                <p><strong>Parsing Status:</strong> {parsedStatus}</p>
                <p><strong>Parsed App ID:</strong> {parsedAppId}</p>
            </div>
        );
    }
    return null;
};


export default function App() {
    const [userId, setUserId] = useState(null);
    const [strategies, setStrategies] = useState([]);
    const [matchLogs, setMatchLogs] = useState([]);
    const [view, setView] = useState('builder');
    const [isAdmin, setIsAdmin] = useState(false);
    const [showAdminLogin, setShowAdminLogin] = useState(false);
    const [isTournamentRunning, setIsTournamentRunning] = useState(false);

    useEffect(() => {
        const handleAuth = async (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                try {
                    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                        await signInWithCustomToken(auth, __initial_auth_token);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (error) {
                    console.error("Authentication failed:", error);
                }
            }
        };
        const unsubscribeAuth = onAuthStateChanged(auth, handleAuth);
        return () => unsubscribeAuth();
    }, []);

    useEffect(() => {
        if (!userId) return;
        const strategiesQuery = query(collection(db, `artifacts/${appId}/public/data/strategies`), orderBy('score', 'desc'));
        const logsQuery = query(collection(db, `artifacts/${appId}/public/data/matchLogs`), orderBy('playedAt', 'desc'));
        
        const unsubStrategies = onSnapshot(strategiesQuery, (snap) => setStrategies(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
        const unsubLogs = onSnapshot(logsQuery, (snap) => setMatchLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))));

        return () => { unsubStrategies(); unsubLogs(); };
    }, [userId]);

    const runGrandTournament = useCallback(async () => {
        if (strategies.length < 2 || isTournamentRunning) return;
        
        setIsTournamentRunning(true);
        const batch = writeBatch(db);
        const newScores = strategies.reduce((acc, s) => ({...acc, [s.id]: 0}), {});

        for (let i = 0; i < strategies.length; i++) {
            for (let j = i + 1; j < strategies.length; j++) {
                const s1 = strategies[i]; const s2 = strategies[j];
                const s1Func = createStrategyFromLogicTree(s1.clauses);
                const s2Func = createStrategyFromLogicTree(s2.clauses);
                let score1 = 0, score2 = 0, h1 = [], h2 = [];
                
                for (let k = 0; k < 20; k++) {
                    const m1 = s1Func(h1, h2), m2 = s2Func(h2, h1);
                    const rk = `${m1}-${m2}`, rs = PAYOFFS[rk];
                    score1 += rs.p1; score2 += rs.p2; h1.push(m1); h2.push(m2);
                }
                
                newScores[s1.id] += score1;
                newScores[s2.id] += score2;

                const matchLogRef = doc(collection(db, `artifacts/${appId}/public/data/matchLogs`));
                batch.set(matchLogRef, {
                    s1_id: s1.id, s1_name: s1.name, s1_author: s1.authorDisplayName,
                    s2_id: s2.id, s2_name: s2.name, s2_author: s2.authorDisplayName,
                    s1_moves: h1, s2_moves: h2, s1_score: score1, s2_score: score2,
                    playedAt: serverTimestamp()
                });
            }
        }
        
        for (const strategy of strategies) {
            const strategyRef = doc(db, `artifacts/${appId}/public/data/strategies`, strategy.id);
            batch.update(strategyRef, { score: newScores[strategy.id] });
        }
        
        try {
            await batch.commit();
            console.log("Grand Tournament complete!");
        } catch (error) {
            console.error("Grand Tournament failed:", error);
        } finally {
            setIsTournamentRunning(false);
        }
    }, [strategies, isTournamentRunning]);

    const runTournamentOnSave = useCallback(async (newStrategy, existingStrategies) => {
        const batch = writeBatch(db);
        const newStrategyFunc = createStrategyFromLogicTree(newStrategy.clauses);
        let totalPointsForNewStrategy = 0;

        for (const opponent of existingStrategies) {
            if(opponent.id === newStrategy.id) continue;
            const opponentFunc = createStrategyFromLogicTree(opponent.clauses);
            let score1 = 0, score2 = 0, h1 = [], h2 = [];
            
            for (let i = 0; i < 20; i++) {
                const m1 = newStrategyFunc(h1, h2), m2 = opponentFunc(h2, h1);
                const rk = `${m1}-${m2}`, rs = PAYOFFS[rk];
                score1 += rs.p1; score2 += rs.p2; h1.push(m1); h2.push(m2);
            }
            
            totalPointsForNewStrategy += score1;
            const opponentRef = doc(db, `artifacts/${appId}/public/data/strategies`, opponent.id);
            batch.update(opponentRef, { score: increment(score2) });

            const matchLogRef = doc(collection(db, `artifacts/${appId}/public/data/matchLogs`));
            batch.set(matchLogRef, {
                s1_id: newStrategy.id, s1_name: newStrategy.name, s1_author: newStrategy.authorDisplayName,
                s2_id: opponent.id, s2_name: opponent.name, s2_author: opponent.authorDisplayName,
                s1_moves: h1, s2_moves: h2, s1_score: score1, s2_score: score2,
                playedAt: serverTimestamp()
            });
        }
        
        const newStrategyRef = doc(db, `artifacts/${appId}/public/data/strategies`, newStrategy.id);
        batch.update(newStrategyRef, { score: increment(totalPointsForNewStrategy) });
        await batch.commit();
    }, []);

    const resetScores = async () => {
        setIsTournamentRunning(true);
        const batch = writeBatch(db);
        strategies.forEach(s => {
            const strategyRef = doc(db, `artifacts/${appId}/public/data/strategies`, s.id);
            batch.update(strategyRef, { score: 0 });
        });
        try {
            await batch.commit();
            alert("All strategy scores have been reset to 0.");
        } catch (error) {
            console.error("Failed to reset scores:", error);
            alert("An error occurred while resetting scores.");
        } finally {
            setIsTournamentRunning(false);
        }
    };
    
    const clearArena = async () => {
        setIsTournamentRunning(true);
        const batch = writeBatch(db);
        const strategiesCollection = collection(db, `artifacts/${appId}/public/data/strategies`);
        const logsCollection = collection(db, `artifacts/${appId}/public/data/matchLogs`);
        const strategiesSnapshot = await getDocs(strategiesCollection);
        const logsSnapshot = await getDocs(logsCollection);
        strategiesSnapshot.forEach(doc => batch.delete(doc.ref));
        logsSnapshot.forEach(doc => batch.delete(doc.ref));

        try {
            await batch.commit();
            alert("The entire Arena (all strategies and logs) has been cleared.");
        } catch (error) {
            console.error("Failed to clear Arena:", error);
            alert("An error occurred while clearing the Arena.");
        } finally {
            setIsTournamentRunning(false);
        }
    };

    const handleAdminLogin = (password) => {
        if (password === 'admin2025') {
            setIsAdmin(true);
            setShowAdminLogin(false);
            return true;
        }
        return false;
    };

    return (
        <div className="bg-gray-900 text-white min-h-screen p-4">
            <header className="text-center mb-8">
                <h1 className="text-5xl font-bold text-white">Game of Trust</h1>
                <p className="text-cyan-400">An Automated Game Theory Tournament</p>
            </header>
            <nav className="flex justify-center gap-4 mb-8">
                <button onClick={() => setView('builder')} className={`px-6 py-2 rounded-lg font-semibold ${view === 'builder' ? 'bg-cyan-600' : 'bg-gray-700'}`}>Builder</button>
                <button onClick={() => setView('arena')} className={`px-6 py-2 rounded-lg font-semibold ${view === 'arena' ? 'bg-cyan-600' : 'bg-gray-700'}`}>Arena</button>
                <button onClick={() => setView('logs')} className={`px-6 py-2 rounded-lg font-semibold ${view === 'logs' ? 'bg-cyan-600' : 'bg-gray-700'}`}>Match Logs</button>
            </nav>
            <main>
                {view === 'builder' && <LogicBuilder userId={userId} allStrategies={strategies} runTournamentOnSave={runTournamentOnSave} />}
                {view === 'arena' && <Arena strategies={strategies} onRunTournament={runGrandTournament} isTournamentRunning={isTournamentRunning} />}
                {view === 'logs' && <MatchLogs logs={matchLogs} />}
            </main>
            <footer className="fixed bottom-0 left-4 py-2">
                <button onClick={() => setShowAdminLogin(true)} className="text-xs text-gray-600 hover:text-cyan-400">Admin</button>
            </footer>
            {showAdminLogin && <AdminLoginModal onLogin={handleAdminLogin} onClose={() => setShowAdminLogin(false)} />}
            {isAdmin && <AdminPanel onRunTournament={runGrandTournament} onResetScores={resetScores} onClearArena={clearArena} isRunning={isTournamentRunning} />}
            <VercelDebugInfo />
        </div>
    );
}
