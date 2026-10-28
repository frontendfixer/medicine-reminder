// Tasks first, before any React code, so headless launches can run them.
import './src/tasks';
import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
