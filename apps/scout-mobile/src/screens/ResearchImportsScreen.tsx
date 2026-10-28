import React, { useState } from 'react';
import { File } from 'expo-file-system';
import {
  Pressable, StyleSheet, Text, TextInput, View
} from 'react-native';

import {
  parseMobileResearchImport,
  type ImportedPreview
} from '../domain/mobileResearchImport';
import { parseResearchResultFile } from '../domain/researchResultFile';
import ResearchPreviewCards from './ResearchPreviewCards';
import ScoutSyncSection from './ScoutSyncSection';

export default function ResearchImportsScreen() {
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<ImportedPreview | null>(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  function load() {
    setPreview(null);
    setError('');

    try {
      setPreview(parseMobileResearchImport(raw));
    } catch {
      setError('Résultat invalide ou non conforme au contrat Scout.');
    }
  }

  async function loadFile() {
    if (importing) return;
    setImporting(true);
    setPreview(null);
    setError('');
    try {
      const selection = await File.pickFileAsync({ mimeTypes: '*/*' });
      if (selection.canceled) return;
      const file = selection.result;
      if (!file.name.toLowerCase().endsWith('.json') ||
          !Number.isSafeInteger(file.size) ||
          file.size < 1 || file.size > 131072) {
        throw new Error('INVALID_JSON_FILE');
      }
      const content = await file.text();
      setPreview(parseResearchResultFile(content));
      setRaw('');
    } catch {
      setError('Fichier Scout refusé : format, taille ou preuves invalides.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
    <ScoutSyncSection />
    <View style={styles.card}>
      <Text style={styles.title}>Résultats Scout</Text>

      <Text style={styles.note}>
        Import local expérimental (fichier ou texte). Les données
        importées restent non authentifiées. Aucune action
        commerciale ni dépense ne sont autorisées.
      </Text>

      <Pressable style={styles.button} onPress={loadFile} disabled={importing}>
        <Text style={styles.buttonText}>
          {importing ? 'Lecture du fichier…' : 'Choisir un fichier Scout (.json)'}
        </Text>
      </Pressable>

      <TextInput
        style={styles.input}
        multiline
        textAlignVertical="top"
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Coller ici un résultat JSON Scout"
        placeholderTextColor="#94a3b8"
        value={raw}
        onChangeText={setRaw}
        maxLength={12000}
      />

      <Pressable style={styles.button} onPress={load}>
        <Text style={styles.buttonText}>Examiner le résultat</Text>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {preview && <ResearchPreviewCards preview={preview} />}
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    padding: 18,
    borderRadius: 14,
    marginBottom: 16
  },
  title: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 18,
    marginBottom: 12
  },
  note: {
    color: '#a8b4c7',
    marginBottom: 12,
    lineHeight: 21
  },
  input: {
    backgroundColor: '#101827',
    color: '#ffffff',
    borderColor: '#475569',
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 100,
    padding: 12,
    marginBottom: 12
  },
  button: {
    backgroundColor: '#166534',
    padding: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 12
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: 'bold'
  },
  error: {
    color: '#fca5a5',
    marginTop: 12
  }
});
