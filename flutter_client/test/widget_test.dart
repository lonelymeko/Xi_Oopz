import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('loads Flutter widget test harness', (WidgetTester tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: Text('Oopz'))),
    );

    expect(find.text('Oopz'), findsOneWidget);
  });
}
