import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import './index.css';
import { router } from './app/router';
import { startLogsSync } from './lib/logs';
import { startMonitorSync } from './lib/monitor';
import { startServerSync } from './lib/server';
import { startThemeSync } from './lib/theme';
import { startTopologySync } from './lib/topology';
import { useWs } from './lib/ws';

startThemeSync();
startServerSync();
startLogsSync();
startMonitorSync();
startTopologySync();
useWs.getState().connect();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
