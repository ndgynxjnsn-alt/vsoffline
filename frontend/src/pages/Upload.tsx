import { useRef, useState, type FormEvent } from 'react';
import { uploadFile } from '../api';
import { Link, itemUrl } from '../router';

interface Job {
  id: number;
  name: string;
  progress: number;
  state: 'uploading' | 'processing' | 'done' | 'failed';
  message?: string;
  identity?: string;
}

interface ImportResult {
  extensions: { imported: string[]; skipped: string[] };
  installers: number;
  files: string[];
}

function JobList({ jobs }: { jobs: Job[] }) {
  return (
    <ul className="jobs">
      {jobs.map((job) => (
        <li key={job.id} className={job.state}>
          <div className="job-line">
            <span>{job.name}</span>
            <span className="muted small">
              {job.state === 'uploading' ? `${Math.round(job.progress * 100)}%` : job.state}
            </span>
          </div>
          {job.state === 'uploading' && <progress value={job.progress} max={1} />}
          {job.message && (
            <div className="small">
              {job.identity ? <Link href={itemUrl(job.identity)}>{job.message}</Link> : job.message}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function useJobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const nextId = useRef(0);
  const add = (name: string) => {
    const id = nextId.current++;
    setJobs((current) => [...current, { id, name, progress: 0, state: 'uploading' }]);
    return (patch: Partial<Job>) => setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  };
  return [jobs, add] as const;
}

export function Upload({ onUploaded }: { onUploaded: () => void }) {
  const [vsixJobs, addVsixJob] = useJobs();
  const [bundleJobs, addBundleJob] = useJobs();

  async function submitVsix(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('vsix') as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      const update = addVsixJob(file.name);
      try {
        const result = (await uploadFile('/api/upload/vsix', file, (progress) =>
          update({ progress, state: progress < 1 ? 'uploading' : 'processing' }),
        )) as { identity: string; version: string };
        update({ state: 'done', message: `${result.identity} ${result.version} is now available`, identity: result.identity });
      } catch (err) {
        update({ state: 'failed', message: (err as Error).message });
      }
    }
    onUploaded();
  }

  async function submitBundle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem('bundle') as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const update = addBundleJob(file.name);
    try {
      const result = (await uploadFile('/api/import', file, (progress) =>
        update({ progress, state: progress < 1 ? 'uploading' : 'processing' }),
      )) as ImportResult;
      const { imported, skipped } = result.extensions;
      update({
        state: 'done',
        message: `Imported ${imported.length} extensions (${skipped.length} skipped, already up to date), ${result.installers} installer files.`,
      });
    } catch (err) {
      update({ state: 'failed', message: (err as Error).message });
    }
    onUploaded();
  }

  return (
    <div className="stack">
      <section className="panel">
        <h2>Upload VSIX extensions</h2>
        <p className="muted">
          Make your own extensions available to everyone. Uploading a newer version replaces the old one. Extensions
          mirrored from the official marketplace cannot be replaced.
        </p>
        <form onSubmit={submitVsix} className="upload-form">
          <input type="file" name="vsix" accept=".vsix" multiple required />
          <button type="submit">Upload</button>
        </form>
        <JobList jobs={vsixJobs} />
      </section>

      <section className="panel">
        <h2>Import artifact bundle</h2>
        <p className="muted">
          Upload a tar created by <code>scripts/download.sh</code> on the internet connected machine. New extension
          versions and VS Code installers are added, old extension versions are deleted.
        </p>
        <form onSubmit={submitBundle} className="upload-form">
          <input type="file" name="bundle" accept=".tar,.tar.gz,.tgz" required />
          <button type="submit">Import</button>
        </form>
        <JobList jobs={bundleJobs} />
      </section>
    </div>
  );
}
