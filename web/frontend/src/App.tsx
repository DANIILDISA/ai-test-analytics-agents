// web/frontend/src/App.tsx
import { Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { ChatScreen, type ChatApi } from "@/components/chat/ChatScreen";
import { NewAnalysis } from "@/screens/NewAnalysis";
import { Results } from "@/screens/Results";
import { History } from "@/screens/History";
import { Comparison } from "@/screens/Comparison";
import { Settings } from "@/screens/Settings";
import { listThreads, getThread, createThread, getSettings, listRuns, patchThread, deleteThread, uploadChatFiles, removeChatUpload, stopChat } from "@/api/client";
import { streamChat, streamConfirm } from "@/api/chatStream";

const chatApi: ChatApi = {
  listThreads,
  getThread,
  createThread,
  getSettings,
  listRuns,
  patchThread,
  deleteThread,
  uploadFiles: uploadChatFiles,
  removeUpload: removeChatUpload,
  stopChat,
  streamConfirm,
  streamChat,
};

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<NewAnalysis />} />
        <Route path="results" element={<Results />} />
        <Route path="history" element={<History />} />
        <Route path="compare" element={<Comparison />} />
        <Route path="chat" element={<ChatScreen api={chatApi} />} />
        {/* The «Экспорт» tab is gone: downloads live on the results page and in the history rows. */}
        <Route path="export" element={<Navigate to="/results" replace />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
