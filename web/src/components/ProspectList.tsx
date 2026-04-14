import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import type { Prospect } from '../types';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'OT', 'OG', 'C', 'EDGE', 'DE', 'DT', 'LB', 'CB', 'S'];

interface ProspectListProps {
  roomCode: string;
  onSelect: (rank: number) => void;
  selectedRank: number | null;
}

export function ProspectList({ roomCode, onSelect, selectedRank }: ProspectListProps) {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [pos, setPos] = useState<string>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const load = useCallback(() => {
    api.getProspects(roomCode, pos || undefined, page, 30).then(d => {
      setProspects(d.prospects);
      setTotalPages(d.totalPages);
    });
  }, [roomCode, pos, page]);

  useEffect(() => { load(); }, [load]);

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [pos]);

  const filtered = search
    ? prospects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))
    : prospects;

  return (
    <div>
      <div className="prospect-search">
        <input
          placeholder="Search prospects..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>
      <div className="position-pills">
        <button className={`pos-pill${!pos ? ' active' : ''}`} onClick={() => setPos('')}>All</button>
        {POSITIONS.map(p => (
          <button key={p} className={`pos-pill${pos === p ? ' active' : ''}`} onClick={() => setPos(pos === p ? '' : p)}>{p}</button>
        ))}
      </div>
      <table className="prospect-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Pos</th>
            <th>School</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(p => (
            <tr key={p.rank} className={selectedRank === p.rank ? 'selected' : ''} onClick={() => onSelect(p.rank)} style={{ cursor: 'pointer' }}>
              <td><span className="prospect-rank">{p.rank}</span></td>
              <td><span className="prospect-name">{p.name}</span></td>
              <td>{p.pos}</td>
              <td>{p.school}</td>
              <td>
                <button className="prospect-draft-btn primary" onClick={e => { e.stopPropagation(); onSelect(p.rank); }}>
                  Select
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 0' }}>
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ fontSize: '0.7rem', padding: '3px 10px' }}>Prev</button>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-dim)', alignSelf: 'center' }}>{page}/{totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ fontSize: '0.7rem', padding: '3px 10px' }}>Next</button>
        </div>
      )}
    </div>
  );
}
