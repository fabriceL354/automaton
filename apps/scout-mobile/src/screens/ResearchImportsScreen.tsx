import React, { useState } from 'react';
import { File } from 'expo-file-system';
import {
  Pressable, StyleSheet, Text, TextInput, View
} from 'react-native';

import { reviewResearchImport, IMPORT_REFUSED, type ResearchImportReview } from '../domain/researchImportReview';
import { LEGACY_RESEARCH_TRUST_WARNING } from '../../../../src/agent/research-data-boundary';
import ResearchPreviewCards from './ResearchPreviewCards';
import ScoutSyncSection from './ScoutSyncSection';
import { isAcceptableScoutJsonFile } from '../domain/scoutJsonFileSelection';

export default function ResearchImportsScreen() {
  const [raw, setRaw] = useState('');
  const [review, setReview] = useState<ResearchImportReview>({ preview: null, error: '' });
  const [importing, setImporting] = useState(false);

  function load() {
    if (importing) return;
    setReview(previous => reviewResearchImport(previous.preview, raw, 'PREVIEW'));
  }

  async function loadFile() {
    if (importing) return;
    setImporting(true);
    setReview(previous => ({ ...previous, error: '' }));
    try {
      const selection = await File.pickFileAsync({ mimeTypes: '*/*' });
      if (selection.canceled) return;
      const file = selection.result;
      if (!isAcceptableScoutJsonFile(file)) {
        throw new Error('INVALID_JSON_FILE');
      }
      const content = await file.text();
      setReview(previous => reviewResearchImport(previous.preview, content, 'RESEARCH_FILE'));
    } catch {
      setReview(previous => ({ ...previous, error: IMPORT_REFUSED }));
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
      <Text style={styles.note}>{LEGACY_RESEARCH_TRUST_WARNING}</Text>

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

      <Pressable style={styles.button} onPress={load} disabled={importing}>
        <Text style={styles.buttonText}>Examiner le résultat</Text>
      </Pressable>

      {review.error ? <Text style={styles.error}>{review.error}</Text> : null}

      {review.preview && <ResearchPreviewCards preview={review.preview} />}
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
