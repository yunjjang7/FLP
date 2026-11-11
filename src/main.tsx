import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import './index.css';
import { startSwUpdate } from './lib/swUpdate';
import Data from './pages/Data';
import Home from './pages/Home';
import Invest from './pages/Invest';
import Prescribe from './pages/Prescribe';
import Retire from './pages/Retire';
import Withdraw from './pages/Withdraw';
import { FlpProvider } from './store/FlpContext';

startSwUpdate();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlpProvider>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="invest" element={<Invest />} />
            <Route path="retire" element={<Retire />} />
            <Route path="prescribe" element={<Prescribe />} />
            <Route path="withdraw" element={<Withdraw />} />
            <Route path="data" element={<Data />} />
          </Route>
        </Routes>
      </HashRouter>
    </FlpProvider>
  </StrictMode>,
);
