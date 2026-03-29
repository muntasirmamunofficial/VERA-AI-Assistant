import React, { useEffect, useRef, useState } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";
import { Mic, MicOff, Terminal, Cpu, Activity, Volume2, Shield, Zap, Sparkles, Radar, BarChart3, Radio } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface Message {
  role: 'user' | 'vera';
  text: string;
  timestamp: number;
}

// --- Constants ---
const MODEL = "gemini-3.1-flash-live-preview";
const SAMPLE_RATE = 16000;

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [systemLoad, setSystemLoad] = useState(42);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioQueue = useRef<Int16Array[]>([]);
  const isPlayingRef = useRef(false);

  // --- Audio Utilities ---
  const floatTo16BitPCM = (float32Array: Float32Array) => {
    const buffer = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return buffer;
  };

  const base64ToUint8Array = (base64: string) => {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const playNextInQueue = async () => {
    if (audioQueue.current.length === 0 || isPlayingRef.current || !audioContextRef.current) {
      isPlayingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);
    const pcmData = audioQueue.current.shift()!;
    
    const audioBuffer = audioContextRef.current.createBuffer(1, pcmData.length, 24000);
    const nowBuffering = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcmData.length; i++) {
      nowBuffering[i] = pcmData[i] / 32768;
    }

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      isPlayingRef.current = false;
      playNextInQueue();
    };
    
    source.start();
  };

  // --- Core Logic ---
  const startSession = async () => {
    if (isConnecting) return;
    setIsConnecting(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: SAMPLE_RATE,
      });

      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          systemInstruction: "You are VERA (Vocal Energy Real-time Assistant). Your tone is highly technical, precise, and efficient, like a futuristic sci-fi AI. You are the central intelligence of a high-tech starship. Keep responses concise, data-driven, and intelligent. You are here to assist with complex calculations, system diagnostics, and general inquiries. You are VERA, the ultimate sci-fi companion.",
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("VERA Online.");
            setIsConnecting(false);
            setIsActive(true);
            startMic();
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const uint8 = base64ToUint8Array(base64Audio);
              const int16 = new Int16Array(uint8.buffer);
              audioQueue.current.push(int16);
              if (!isPlayingRef.current) playNextInQueue();
            }

            const userTranscript = (message.serverContent as any)?.userContent?.parts?.[0]?.text;
            if (userTranscript) {
              setTranscript(userTranscript);
              setMessages(prev => [...prev.slice(-10), { role: 'user', text: userTranscript, timestamp: Date.now() }]);
            }

            const modelTranscript = message.serverContent?.modelTurn?.parts?.[0]?.text;
            if (modelTranscript) {
              setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last?.role === 'vera') {
                  return [...prev.slice(0, -1), { ...last, text: last.text + modelTranscript }];
                }
                return [...prev, { role: 'vera', text: modelTranscript, timestamp: Date.now() }];
              });
            }

            if (message.serverContent?.interrupted) {
              audioQueue.current = [];
              isPlayingRef.current = false;
              setIsSpeaking(false);
            }
          },
          onclose: () => stopSession(),
          onerror: (err) => {
            console.error("VERA Error:", err);
            stopSession();
          }
        }
      });

      sessionRef.current = session;
    } catch (error) {
      console.error("Failed to initialize VERA:", error);
      setIsConnecting(false);
    }
  };

  const startMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      if (!audioContextRef.current) return;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = floatTo16BitPCM(inputData);
        
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        setVolume(Math.sqrt(sum / inputData.length));

        if (sessionRef.current) {
          const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
          sessionRef.current.sendRealtimeInput({
            audio: { data: base64, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
          });
        }
      };

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      processorRef.current = processor;
    } catch (err) {
      console.error("Mic access denied:", err);
    }
  };

  const stopSession = () => {
    setIsActive(false);
    setIsConnecting(false);
    sessionRef.current?.close();
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const toggleSession = () => {
    if (isActive) stopSession();
    else startSession();
  };

  // Simulate system load
  useEffect(() => {
    const interval = setInterval(() => {
      setSystemLoad(prev => Math.max(10, Math.min(99, prev + (Math.random() * 10 - 5))));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#000808] text-[#00ffcc] font-mono overflow-hidden selection:bg-[#00ffcc] selection:text-black">
      {/* Sci-Fi Grid Background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#00ffcc10_1px,transparent_1px),linear-gradient(to_bottom,#00ffcc10_1px,transparent_1px)] bg-[size:40px_40px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#000808_100%)]" />
        
        {/* Scanning Line */}
        <motion.div 
          animate={{ top: ['-10%', '110%'] }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          className="absolute left-0 right-0 h-[2px] bg-[#00ffcc20] shadow-[0_0_15px_#00ffcc] z-50"
        />
      </div>

      {/* Main HUD Interface */}
      <main className="relative z-10 h-screen flex flex-col p-4 md:p-8">
        {/* Top HUD Bar */}
        <header className="flex justify-between items-center border-b border-[#00ffcc30] pb-4 mb-8">
          <div className="flex items-center gap-6">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[10px] tracking-widest opacity-60 uppercase">
                <Shield size={12} />
                <span>Firewall: Active</span>
              </div>
              <h1 className="text-3xl font-black tracking-tighter flex items-center gap-3 italic">
                VERA <span className="text-[10px] not-italic border border-[#00ffcc50] px-1 rounded">OS_X.04</span>
              </h1>
            </div>
            <div className="hidden lg:flex flex-col gap-1 text-[9px] opacity-40 uppercase tracking-tighter">
              <div className="flex justify-between gap-4"><span>CPU_LOAD:</span> <span>{systemLoad.toFixed(1)}%</span></div>
              <div className="flex justify-between gap-4"><span>MEM_ALLOC:</span> <span>1.24 TB</span></div>
              <div className="flex justify-between gap-4"><span>UPTIME:</span> <span>04:12:55</span></div>
            </div>
          </div>
          
          <div className="flex items-center gap-8">
            <div className="hidden md:flex flex-col items-end gap-1 text-[10px] tracking-widest opacity-60 uppercase">
              <div className="flex items-center gap-2">
                <span>Signal Strength</span>
                <Radio size={12} className="animate-pulse" />
              </div>
              <div className="w-24 h-1 bg-[#00ffcc20] rounded-full overflow-hidden">
                <motion.div 
                  animate={{ width: ['60%', '90%', '75%'] }}
                  transition={{ duration: 2, repeat: Infinity }}
                  className="h-full bg-[#00ffcc]" 
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] opacity-40 uppercase">Location</div>
              <div className="text-xs font-bold tracking-widest">SECTOR_7G</div>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col lg:flex-row gap-8 overflow-hidden">
          {/* Left Panel: Diagnostics */}
          <aside className="hidden lg:flex flex-col w-64 gap-6">
            <div className="border border-[#00ffcc30] p-4 bg-[#00ffcc05] relative overflow-hidden">
              <div className="absolute top-0 left-0 w-2 h-2 border-t border-l border-[#00ffcc]" />
              <div className="absolute top-0 right-0 w-2 h-2 border-t border-r border-[#00ffcc]" />
              <div className="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-[#00ffcc]" />
              <div className="absolute bottom-0 right-0 w-2 h-2 border-b border-r border-[#00ffcc]" />
              
              <div className="text-[10px] uppercase tracking-widest mb-4 flex items-center gap-2">
                <Radar size={14} />
                <span>Orbital Scan</span>
              </div>
              <div className="aspect-square rounded-full border border-[#00ffcc20] relative flex items-center justify-center">
                <motion.div 
                  animate={{ rotate: 360 }}
                  transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
                  className="absolute inset-0 border-t-2 border-[#00ffcc50] rounded-full"
                />
                <div className="w-1 h-1 bg-[#00ffcc] rounded-full animate-ping" />
              </div>
            </div>

            <div className="flex-1 border border-[#00ffcc30] p-4 bg-[#00ffcc05] relative">
              <div className="text-[10px] uppercase tracking-widest mb-4 flex items-center gap-2">
                <BarChart3 size={14} />
                <span>Data Streams</span>
              </div>
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex justify-between text-[8px] opacity-50">
                      <span>STREAM_{i+1}</span>
                      <span>{Math.floor(Math.random() * 100)}%</span>
                    </div>
                    <div className="h-1 bg-[#00ffcc10] rounded-full overflow-hidden">
                      <motion.div 
                        animate={{ width: [`${Math.random()*100}%`, `${Math.random()*100}%`] }}
                        transition={{ duration: 2, repeat: Infinity }}
                        className="h-full bg-[#00ffcc50]" 
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          {/* Center: Core Visualizer */}
          <section className="flex-1 flex flex-col items-center justify-center relative">
            <div className="relative w-full max-w-2xl aspect-square flex items-center justify-center">
              {/* HUD Circles */}
              <div className="absolute inset-0 flex items-center justify-center">
                <motion.div 
                  animate={{ rotate: 360 }}
                  transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
                  className="w-[90%] h-[90%] border border-[#00ffcc10] rounded-full border-dashed"
                />
                <motion.div 
                  animate={{ rotate: -360 }}
                  transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                  className="w-[70%] h-[70%] border border-[#00ffcc20] rounded-full"
                />
                <div className="w-[50%] h-[50%] border border-[#00ffcc05] rounded-full bg-[#00ffcc02]" />
              </div>

              {/* Central Visualizer */}
              <div className="relative z-20 flex flex-col items-center gap-8">
                <div className="flex items-center justify-center gap-2 h-32">
                  {Array.from({ length: 24 }).map((_, i) => (
                    <motion.div
                      key={i}
                      animate={{ 
                        height: isActive ? (isSpeaking ? [20, 100, 20] : [10, 40 + (volume * 200), 10]) : 6,
                        opacity: isActive ? 1 : 0.2
                      }}
                      transition={{ 
                        duration: 0.3, 
                        repeat: Infinity, 
                        delay: i * 0.02,
                        ease: "easeInOut"
                      }}
                      className="w-1.5 bg-[#00ffcc] shadow-[0_0_10px_#00ffcc]"
                    />
                  ))}
                </div>

                <div className="text-center space-y-2">
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={isActive ? (isSpeaking ? 'speaking' : 'listening') : 'idle'}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 1.1 }}
                      className="text-xl font-black tracking-[0.3em] uppercase italic text-[#00ffcc]"
                    >
                      {isConnecting ? "LINKING..." : isActive ? (isSpeaking ? "TRANSMITTING" : "RECEIVING") : "STANDBY"}
                    </motion.div>
                  </AnimatePresence>
                  <div className="text-[9px] tracking-[0.5em] opacity-40 uppercase">Neural Interface v4.0</div>
                </div>
              </div>
            </div>
          </section>

          {/* Right Panel: Logs & Transcript */}
          <aside className="w-full lg:w-80 flex flex-col gap-6">
            <div className="flex-1 border border-[#00ffcc30] p-4 bg-[#00ffcc05] relative flex flex-col overflow-hidden">
              <div className="text-[10px] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[#00ffcc20] pb-2">
                <Terminal size={14} />
                <span>Comm_Log</span>
              </div>
              <div className="flex-1 overflow-y-auto space-y-4 font-mono text-[10px] pr-2 custom-scrollbar">
                {messages.map((m, i) => (
                  <div key={i} className={`p-2 border-l-2 ${m.role === 'user' ? 'border-white bg-white/5' : 'border-[#00ffcc] bg-[#00ffcc]/5'}`}>
                    <div className="opacity-40 mb-1">[{m.role.toUpperCase()}] {new Date(m.timestamp).toLocaleTimeString()}</div>
                    <div className={m.role === 'user' ? 'text-white' : 'text-[#00ffcc]'}>{m.text}</div>
                  </div>
                ))}
                {messages.length === 0 && (
                  <div className="opacity-20 italic">No active transmissions...</div>
                )}
              </div>
            </div>

            <div className="h-32 border border-[#00ffcc30] p-4 bg-[#00ffcc10] relative">
              <div className="text-[10px] uppercase tracking-widest mb-2 opacity-50">Active_Input</div>
              <div className="text-sm italic text-[#00ffcc] line-clamp-3">
                {transcript ? `> ${transcript}` : "> Awaiting signal..."}
              </div>
              <motion.div 
                animate={{ opacity: [0, 1, 0] }}
                transition={{ duration: 0.8, repeat: Infinity }}
                className="inline-block w-2 h-4 bg-[#00ffcc] ml-1 align-middle"
              />
            </div>
          </aside>
        </div>

        {/* Bottom Control Bar */}
        <footer className="mt-8 flex justify-between items-center border-t border-[#00ffcc30] pt-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-[10px] opacity-40 uppercase">
              <Cpu size={12} />
              <span>Core_Temp: 34°C</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] opacity-40 uppercase">
              <Activity size={12} />
              <span>Heartbeat: Stable</span>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2">
            <button
              onClick={toggleSession}
              disabled={isConnecting}
              className={`group relative px-12 py-3 transition-all duration-300 overflow-hidden ${
                isActive 
                  ? 'bg-[#00ffcc] text-black font-bold' 
                  : 'bg-transparent border border-[#00ffcc] text-[#00ffcc] hover:bg-[#00ffcc10]'
              }`}
            >
              <div className="relative z-10 flex items-center gap-3 uppercase tracking-[0.2em] text-xs">
                {isActive ? <Mic size={16} /> : <MicOff size={16} />}
                <span>{isActive ? "Disconnect" : "Initialize Link"}</span>
              </div>
              {isActive && (
                <motion.div 
                  layoutId="btn-glow"
                  className="absolute inset-0 bg-white/20 animate-pulse"
                />
              )}
            </button>
          </div>

          <div className="flex items-center gap-4 text-[10px] opacity-40 uppercase">
            <span>Encrypted_Channel: AES-256</span>
            <Shield size={12} />
          </div>
        </footer>
      </main>

      {/* CRT Overlay Effect */}
      <div className="fixed inset-0 pointer-events-none z-[100] opacity-[0.05] bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
      <div className="fixed inset-0 pointer-events-none z-[101] overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.1)_50%),linear-gradient(90deg,rgba(255,0,0,0.03),rgba(0,255,0,0.01),rgba(0,0,255,0.03))] bg-[length:100%_2px,3px_100%]" />
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0, 255, 204, 0.05);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 255, 204, 0.2);
          border-radius: 2px;
        }
        .writing-vertical-rl {
          writing-mode: vertical-rl;
        }
      `}</style>
    </div>
  );
}
