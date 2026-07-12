import { Authenticator, translations } from '@aws-amplify/ui-react';
import { Amplify } from 'aws-amplify';
import { I18n } from 'aws-amplify/utils';
import outputs from '../amplify_outputs.json';
import { realApi } from './api';
import { Dashboard } from './Dashboard';
import { mockApi } from './mock';
import '@aws-amplify/ui-react/styles.css';
import './fortune.css';

const DEMO = import.meta.env.VITE_DEMO === '1';

if (!DEMO) {
  Amplify.configure(outputs as Parameters<typeof Amplify.configure>[0]);
  I18n.putVocabularies(translations);
  I18n.setLanguage('ja');
}

export default function App() {
  if (DEMO) {
    return <Dashboard api={mockApi} userEmail="demo@example.com" onSignOut={() => {}} />;
  }
  return (
    <div className="auth-bg">
      <Authenticator>
        {({ signOut, user }) => (
          <Dashboard
            api={realApi}
            userEmail={user?.signInDetails?.loginId ?? ''}
            onSignOut={() => signOut?.()}
          />
        )}
      </Authenticator>
    </div>
  );
}
