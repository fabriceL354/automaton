import OpportunitiesScreen from './src/screens/OpportunitiesScreen';
import ResearchImportsScreen from './src/screens/ResearchImportsScreen';
import React, { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ScrollView, View, Text,
  Pressable, StatusBar, StyleSheet
} from 'react-native';

type Page = 'Accueil' | 'Opportunités' | 'Projets' | 'Réglages';

const pages: Page[] = ['Accueil', 'Opportunités', 'Projets', 'Réglages'];

const exemples = [
  {
    titre: 'Modèle de tableur',
    categorie: 'Produit numérique',
    cout: '8 €',
    statut: 'Démonstration'
  },
  {
    titre: 'Guide PDF spécialisé',
    categorie: 'Produit numérique',
    cout: 'À évaluer',
    statut: 'Démonstration'
  }
];

export default function App() {
  const [page, setPage] = useState<Page>('Accueil');

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.logo}>SCOUT</Text>
        <Text style={styles.subtitle}>Assistant de projets économiques</Text>
      </View>

      <View style={styles.navigation}>
        {pages.map(item => (
          <Pressable
            key={item}
            onPress={() => setPage(item)}
            style={[
              styles.tab,
              page === item && styles.activeTab
            ]}
          >
            <Text style={[
              styles.tabText,
              page === item && styles.activeTabText
            ]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{page}</Text>

        {page === 'Accueil' && (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>ÉTAT DE SCOUT</Text>
              <Text style={styles.value}>Mode démonstration</Text>
              <Text style={styles.info}>
                Interface Android opérationnelle.
                Moteur de recherche non connecté.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>VERSION DE RÉFÉRENCE</Text>
              <Text style={styles.value}>Scout V14.6</Text>
              <Text style={styles.info}>
                Moteur stable conservé sur GitHub.
                Application mobile en développement.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.label}>SÉCURITÉ</Text>
              <Text style={styles.value}>Aucune dépense autorisée</Text>
              <Text style={styles.info}>
                Aucun paiement ni action commerciale.
              </Text>
            </View>
          </>
        )}

        {page === 'Accueil' && <ResearchImportsScreen />}

        {page === 'Opportunités' && <OpportunitiesScreen />}

        {page === 'Projets' && (
          <View style={styles.card}>
            <Text style={styles.value}>Aucun projet actif</Text>
            <Text style={styles.info}>
              Les projets réels seront ajoutés après
              le raccordement du stockage local.
            </Text>
          </View>
        )}

        {page === 'Réglages' && (
          <>
            <View style={styles.card}>
              <Text style={styles.value}>Intelligence artificielle</Text>
              <Text style={styles.info}>Non connectée</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.value}>Dépenses automatiques</Text>
              <Text style={styles.info}>Désactivées</Text>
            </View>
          </>
        )}
      </ScrollView>

      <Text style={styles.footer}>
        SCOUT ANDROID • PROTOTYPE LOCAL
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#101827'
  },
  header: {
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18
  },
  logo: {
    color: '#4ade80',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 3
  },
  subtitle: {
    color: '#a8b4c7',
    marginTop: 5,
    fontSize: 13
  },
  navigation: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingBottom: 12
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 9
  },
  activeTab: {
    backgroundColor: '#234934'
  },
  tabText: {
    color: '#9caac0',
    fontSize: 11
  },
  activeTabText: {
    color: '#86efac',
    fontWeight: 'bold'
  },
  content: {
    padding: 20,
    paddingBottom: 40
  },
  title: {
    color: '#ffffff',
    fontSize: 25,
    fontWeight: 'bold',
    marginBottom: 22
  },
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 20,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#334155'
  },
  label: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 10
  },
  value: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 8
  },
  info: {
    color: '#a8b4c7',
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 6
  },
  badge: {
    color: '#86efac',
    marginTop: 10,
    fontSize: 12
  },
  footer: {
    color: '#64748b',
    textAlign: 'center',
    padding: 14,
    fontSize: 10
  }
});
